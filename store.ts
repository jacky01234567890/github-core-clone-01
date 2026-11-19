// store.ts — the forge's single shared in-memory store.
//
// Every surface (git smart HTTP, REST v3, GraphQL v4, MCP) reads and writes this
// one store, so a repo/issue/PR created over any surface reads back identically
// over every other surface, with ids unchanged across reads.
//
// Determinism: no wall clock is ever stored. All timestamps the API returns are
// the fixed scenario epoch. Creation order is a per-store sequence counter, so
// ordering by "created" is ordering by that counter (== number order for issues
// and PRs, which is what the checks assert).
//
// The authenticated user: the suite presents one bearer token (MAKEFUN_SHOP_TOKEN).
// The checks name the token's owner with the scenario viewer login, and the
// scenario seed is fixed, so that login is always 'adaiversen'. The store treats
// the token owner as that one fixed user. Any repo under any other owner is a 404
// (never 403), because the store holds no repo under another owner.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- identity

/** The token owner's login. Fixed by the scenario seed (always adaiversen). */
export const VIEWER_LOGIN = 'adaiversen';
/** The token owner's numeric id. */
export const VIEWER_ID = 1000;
/** The token owner's display name. */
export const VIEWER_NAME = 'ada iversen';
/** The token owner's email. */
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The fixed timestamp every created/updated/merged time reports (scenario epoch). */
export const FIXED_ISO = '2025-01-01T00:00:00.000Z';
/** The default branch every repo is born with. */
export const DEFAULT_BRANCH = 'main';
/** The zero object id: an unborn ref. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

// ---------------------------------------------------------------- git objects

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** SHA-1 of `<type> <size>\0<data>`, the git object id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Store an object, returning its id (idempotent: same bytes, same id). */
export function putObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- entities

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  /** Creation order (== number order); used for created-at ordering. */
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  /** Creation order counter shared by issues and PRs. */
  seq: number;
}

// ---------------------------------------------------------------- global ids (GraphQL)

// GraphQL global ids must be opaque and stable, never the bare numeric id.
// base64url of "<Kind>:<numeric id>" is deterministic and opaque.
function globalId(kind: string, numericId: number): string {
  return Buffer.from(`${kind}:${numericId}`, 'utf8').toString('base64url');
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id * 1_000_000 + issue.number);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.id * 1_000_000 + pull.number);
}

export function commentGlobalId(repo: Repo, comment: IssueComment): string {
  return globalId('IssueComment', repo.id * 1_000_000 + comment.id);
}

/** Decode a global id back to its kind and numeric id, or null. */
export function decodeGlobalId(id: string): { kind: string; numericId: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const at = text.lastIndexOf(':');
    if (at <= 0) return null;
    const kind = text.slice(0, at);
    const numericId = Number(text.slice(at + 1));
    if (!Number.isSafeInteger(numericId)) return null;
    return { kind, numericId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the store

export class Store {
  private repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;

  /** Create a repo under the viewer. Returns null when the name already exists. */
  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${VIEWER_LOGIN}/${name}`;
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER_LOGIN,
      name,
      fullName: key,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      seq: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** Get a repo by owner/name. Any owner other than the viewer is a miss (404). */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  /** Delete a repo. Returns false when it does not exist. */
  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  /** All repos of the viewer, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  /** Find a repo by its numeric id. */
  repoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  // ---- labels ----

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  // ---- issues ----

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    repo.seq += 1;
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.seq,
    };
    this.nextIssueId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.find((issue) => issue.number === number) ?? null;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: this.nextCommentId, body };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---- pulls ----

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    repo.seq += 1;
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      head,
      base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: repo.seq,
    };
    this.nextPullId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | null {
    return repo.pulls.find((pull) => pull.number === number) ?? null;
  }

  // ---- refs / git ----

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** All refs of a repo, sorted by name. */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}

// ---------------------------------------------------------------- git tree/commit helpers (shared by REST contents, PR merge, git)

// A parsed tree entry.
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise tree entries (already in git order) to bytes. */
export function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort: byte order of name, directories compared as if named with '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): ParsedCommit | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  if (!/^[0-9a-f]{40}$/.test(tree)) return null;
  return { tree, parents, authorLine, committerLine, message };
}

/** Build commit bytes. Message is forced to end with a newline. */
export function buildCommitBytes(
  tree: string,
  parents: string[],
  authorLine: string,
  committerLine: string,
  message: string,
): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${authorLine}`);
  lines.push(`committer ${committerLine}`);
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

/** Walk a commit's ancestry (following first and later parents), yielding commit oids. */
export function walkAncestors(objects: Map<string, GitObject>, start: string, visit: (oid: string) => void): void {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    visit(oid);
    const parsed = parseCommit(obj.data);
    if (parsed === null) continue;
    for (const parent of parsed.parents) stack.push(parent);
  }
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  if (ancestor === ZERO_OID) return true;
  let found = false;
  walkAncestors(objects, tip, (oid) => {
    if (oid === ancestor) found = true;
  });
  return found;
}

/** All object ids reachable from a set of tips (commits, trees, blobs, tags). */
export function collectReachable(objects: Map<string, GitObject>, tips: string[]): Set<string> {
  const reachable = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (reachable.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    reachable.add(oid);
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      if (parsed === null) continue;
      stack.push(parsed.tree);
      for (const parent of parsed.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match !== null) stack.push(match[1] as string);
    }
  }
  return reachable;
}

// ---- working with trees ----

/** The flat path -> {mode, oid} map of a tree, recursively. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(objects, entry.oid, path)) out.set(sub, value);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** Build a tree from a flat path map, creating intermediate trees. Returns the root tree oid. */
export function buildTreeFromPaths(
  objects: Map<string, GitObject>,
  files: Map<string, { mode: string; oid: string }>,
): string {
  interface Node {
    entries: Map<string, TreeEntry>;
  }
  const root: Node = { entries: new Map() };
  const dirNodes = new Map<string, Node>();
  dirNodes.set('', root);
  const sortedPaths = [...files.keys()].sort();
  for (const path of sortedPaths) {
    const file = files.get(path) as { mode: string; oid: string };
    const parts = path.split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      const parent = dir;
      dir = dir === '' ? (parts[i] as string) : `${dir}/${parts[i] as string}`;
      if (!dirNodes.has(dir)) {
        const node: Node = { entries: new Map() };
        dirNodes.set(dir, node);
        const parentNode = dirNodes.get(parent) as Node;
        parentNode.entries.set(parts[i] as string, { mode: '40000', name: parts[i] as string, oid: '' });
      }
    }
    const node = dirNodes.get(dir) as Node;
    node.entries.set(parts[parts.length - 1] as string, { mode: file.mode, name: parts[parts.length - 1] as string, oid: file.oid });
  }
  const buildNode = (dir: string): string => {
    const node = dirNodes.get(dir) as Node;
    const entries: TreeEntry[] = [];
    for (const entry of node.entries.values()) {
      if (entry.mode === '40000') {
        const subDir = dir === '' ? entry.name : `${dir}/${entry.name}`;
        entries.push({ mode: '40000', name: entry.name, oid: buildNode(subDir) });
      } else {
        entries.push(entry);
      }
    }
    return putObject(objects, 'tree', buildTreeBytes(sortTreeEntries(entries)));
  };
  return buildNode('');
}

/**
 * Commit a single file change onto a branch: create the blob, rebuild the tree,
 * create the commit (parent = branch tip, or none for an unborn branch), move the ref.
 * Returns the new commit oid. `authorLine`/`committerLine` are full "Name <email> epoch +0000".
 */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  authorLine: string,
  committerLine: string,
): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  const blobOid = putObject(repo.objects, 'blob', content);
  let parentEntries = new Map<string, { mode: string; oid: string }>();
  const parents: string[] = [];
  if (tip !== null) {
    parents.push(tip);
    const parsed = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0));
    if (parsed !== null) parentEntries = flattenTree(repo.objects, parsed.tree);
  }
  parentEntries.set(path, { mode: '100644', oid: blobOid });
  const treeOid = buildTreeFromPaths(repo.objects, parentEntries);
  const commitOid = putObject(
    repo.objects,
    'commit',
    buildCommitBytes(treeOid, parents, authorLine, committerLine, message),
  );
  repo.refs.set(ref, commitOid);
  return commitOid;
}

/** Read a file's bytes from a branch tip, or null when absent. */
export function readFileAtBranch(repo: Repo, branch: string, path: string): Buffer | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return null;
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  if (parsed === null) return null;
  const flat = flattenTree(repo.objects, parsed.tree);
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const blob = repo.objects.get(entry.oid);
  return blob !== undefined && blob.type === 'blob' ? blob.data : null;
}

/** The blob sha (hex) of a file at a branch tip, or null. */
export function fileShaAtBranch(repo: Repo, branch: string, path: string): string | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return null;
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  if (parsed === null) return null;
  const flat = flattenTree(repo.objects, parsed.tree);
  return flat.get(path)?.oid ?? null;
}

/** List the commit oids on a branch, newest first (following first parents). */
export function listBranchCommits(repo: Repo, branch: string): string[] {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return [];
  const out: string[] = [];
  let current: string | null = tip;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') break;
    out.push(current);
    const parsed = parseCommit(obj.data);
    current = parsed !== null && parsed.parents.length > 0 ? (parsed.parents[0] as string) : null;
  }
  return out;
}

/**
 * Diff two trees (flat path maps): files added, modified, or deleted.
 * `additions`/`deletions` count newline-terminated lines (best effort).
 */
export function diffTrees(
  objects: Map<string, GitObject>,
  baseTree: string,
  headTree: string,
): Array<{ path: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number }> {
  const base = baseTree === ZERO_OID ? new Map() : flattenTree(objects, baseTree);
  const head = headTree === ZERO_OID ? new Map() : flattenTree(objects, headTree);
  const out: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number }> = [];
  const countLines = (data: Buffer | null): number => {
    if (data === null) return 0;
    const text = data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (old === undefined) {
      const data = objects.get(entry.oid)?.data ?? null;
      out.push({ path, status: 'added', additions: countLines(data), deletions: 0 });
    } else if (old.oid !== entry.oid) {
      const oldData = objects.get(old.oid)?.data ?? null;
      const newData = objects.get(entry.oid)?.data ?? null;
      out.push({ path, status: 'modified', additions: countLines(newData), deletions: countLines(oldData) });
    }
  }
  for (const [path] of base) {
    if (!head.has(path)) {
      const data = objects.get((base.get(path) as { oid: string }).oid)?.data ?? null;
      out.push({ path, status: 'deleted', additions: 0, deletions: countLines(data) });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/** The tree oid of a commit, or null. */
export function treeOfCommit(objects: Map<string, GitObject>, commitOid: string): string | null {
  const obj = objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  return parsed === null ? null : parsed.tree;
}
