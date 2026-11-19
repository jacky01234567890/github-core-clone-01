// rest.ts — GitHub REST v3 surface (/api/v3) for the forge entry.
//
// Implemented against sdk/conformance/checks-rest.ts + rest-client.ts.
// Reads/writes only through the shared store (store.ts) plus node built-ins.
// No clock, no randomness: every timestamp is FIXED_ISO and every commit
// author/committer line uses the fixed scenario epoch.

import {
  buildCommitBytes,
  commitFile,
  diffTrees,
  fileShaAtBranch,
  FIXED_ISO,
  flattenTree,
  hashObject,
  listBranchCommits,
  parseCommit,
  putObject,
  treeOfCommit,
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  ZERO_OID,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

/** Fixed scenario epoch (2025-01-01T00:00:00Z) used in commit author/committer lines. */
const EPOCH = 1735689600;
const AUTHOR_LINE = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${EPOCH} +0000`;
const JSON_TYPE = 'application/json; charset=utf-8';
const SHA40 = /^[0-9a-f]{40}$/i;

export type RestResult = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function respond(status: number, body: unknown, extraHeaders: Record<string, string> = {}): RestResult {
  const text = body === null ? '' : JSON.stringify(body);
  return {
    status,
    headers: { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), ...extraHeaders },
    body: Buffer.from(text, 'utf8'),
  };
}

function err(status: number, message: string, extraHeaders: Record<string, string> = {}): RestResult {
  return respond(status, { message }, extraHeaders);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; result: RestResult };

/** Parse a JSON request body. Empty or malformed JSON, or a non-object, is a 400. */
function parseBody(body: Buffer): BodyResult {
  if (body.length === 0) return { ok: false, result: err(400, 'Request body must be valid JSON') };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, result: err(400, 'Request body must be valid JSON') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, result: err(400, 'Request body must be a JSON object') };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Parse a ?per_page=/&page= pair; defaults 30/1. */
function pagination(url: URL): { perPage: number; page: number } {
  const rawPerPage = url.searchParams.get('per_page');
  const rawPage = url.searchParams.get('page');
  let perPage = rawPerPage === null ? 30 : Number.parseInt(rawPerPage, 10);
  let page = rawPage === null ? 1 : Number.parseInt(rawPage, 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { perPage, page };
}

function pageSlice<T>(items: readonly T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------- shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const known = repo.labels.get(name);
      return known !== undefined ? { name: known.name, color: known.color } : { name };
    }),
    user: { login: VIEWER_LOGIN },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: branchTip(repo, pull.head) ?? ZERO_OID },
    base: { ref: pull.base, sha: branchTip(repo, pull.base) ?? ZERO_OID },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

// ---------------------------------------------------------------- git helpers

interface FlatEntry {
  mode: string;
  oid: string;
}

/**
 * Build a git tree object from a flat path -> entry map, creating intermediate
 * trees. Returns the root tree oid. Pure store helper use: putObject only.
 */
function buildTreeFromFlat(objects: Map<string, { type: string; data: Buffer }>, files: Map<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const buildNode = (node: Node): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: buildNode(child) });
    entries.sort((a, b) => {
      const an = a.mode === '40000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const entry of entries) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.oid, 'hex'));
    }
    return putObject(objects, 'tree', Buffer.concat(parts));
  };
  return buildNode(root);
}

/** Create one commit with the given flat tree on `branch` (parent = tip, or none). */
function commitTree(repo: Repo, branch: string, files: Map<string, FlatEntry>, message: string): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  const treeOid = buildTreeFromFlat(repo.objects, files);
  const parents = tip === null ? [] : [tip];
  const commitOid = putObject(
    repo.objects,
    'commit',
    buildCommitBytes(treeOid, parents, AUTHOR_LINE, AUTHOR_LINE, message),
  );
  repo.refs.set(ref, commitOid);
  return commitOid;
}

/** Resolve a branch name, a full ref, or a raw commit oid to a commit tip, or null. */
function resolveTip(repo: Repo, refParam: string | null, defaultBranch: string): string | null {
  if (refParam === null || refParam === '') {
    return repo.refs.get(`refs/heads/${defaultBranch}`) ?? null;
  }
  const direct = repo.refs.get(refParam);
  if (direct !== undefined) return direct;
  const headed = repo.refs.get(`refs/heads/${refParam}`);
  if (headed !== undefined) return headed;
  const obj = repo.objects.get(refParam);
  if (obj !== undefined && obj.type === 'commit') return refParam;
  return null;
}

/** First-parent walk from a commit oid, newest first. */
function walkFirstParent(repo: Repo, start: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | null = start;
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

/** All ancestors of a tip (every parent), as a set. */
function ancestorSet(repo: Repo, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    const parsed = parseCommit(obj.data);
    if (parsed === null) continue;
    for (const parent of parsed.parents) stack.push(parent);
  }
  return seen;
}

/** The merge-base of two tips: the first ancestor of `baseTip` also reachable from `headTip`. */
function mergeBase(repo: Repo, headTip: string, baseTip: string): string | null {
  const headAncestors = ancestorSet(repo, headTip);
  for (const oid of walkFirstParent(repo, baseTip)) {
    if (headAncestors.has(oid)) return oid;
  }
  // Fall back to a full walk of the base side (non-linear histories).
  const stack = [baseTip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (headAncestors.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    if (parsed === null) continue;
    for (const parent of parsed.parents) stack.push(parent);
  }
  return null;
}

function commitMessageOf(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return '';
  const parsed = parseCommit(obj.data);
  if (parsed === null) return '';
  return parsed.message.replace(/\n+$/, '');
}

function isValidBase64(value: string): boolean {
  const stripped = value.replace(/[\r\n\t ]+/g, '');
  if (stripped === '') return true;
  if (stripped.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) return false;
  return Buffer.from(stripped, 'base64').toString('base64') === stripped;
}

// ---------------------------------------------------------------- handler

export async function handleRestRequest(
  method: string,
  url: URL,
  _headers: Headers,
  body: Buffer,
  store: Store,
  isAuthed: boolean,
): Promise<RestResult | null> {
  const pathname = url.pathname;
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return null;

  if (!isAuthed) return err(401, 'Requires authentication');

  const segments = pathname
    .split('/')
    .filter((part) => part !== '')
    .map(decodeSegment);
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);
  const m = method.toUpperCase();
  const hasBodyMethod = m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';

  // -- root -----------------------------------------------------------------
  if (rest.length === 0) {
    if (m !== 'GET') return err(404, 'Not Found');
    return respond(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo' },
    );
  }

  // -- meta -----------------------------------------------------------------
  if (rest.length === 1 && rest[0] === 'meta') {
    if (m !== 'GET') return err(404, 'Not Found');
    return respond(200, { installed_version: '1.0.0' });
  }

  // -- /user/repos ----------------------------------------------------------
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (m === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return parsed.result;
      const name = asString(parsed.value.name);
      if (name === null || name.trim() === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
      const isPrivate = parsed.value.private === true;
      const description = asString(parsed.value.description) ?? '';
      const repo = store.createRepo(name, description, isPrivate);
      if (repo === null) return err(422, 'Repository already exists');
      return respond(201, repoJson(repo));
    }
    if (m === 'GET') {
      const { perPage, page } = pagination(url);
      const all = store.listRepos();
      const items = pageSlice(all, perPage, page);
      const extra: Record<string, string> = {};
      if (page * perPage < all.length) {
        const nextUrl = new URL(url.toString());
        nextUrl.searchParams.set('per_page', String(perPage));
        nextUrl.searchParams.set('page', String(page + 1));
        extra.link = `<${nextUrl.toString()}>; rel="next"`;
      }
      return respond(200, items.map(repoJson), extra);
    }
    return err(404, 'Not Found');
  }

  // -- /repos/{owner}/{repo}/... --------------------------------------------
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const repoName = rest[2] as string;
    const repo = store.getRepo(owner, repoName);
    if (repo === null) return err(404, 'Not Found');
    const tail = rest.slice(3);

    // /repos/{o}/{r} itself
    if (tail.length === 0) {
      if (m === 'GET') return respond(200, repoJson(repo));
      if (m === 'PATCH') {
        const parsed = parseBody(body);
        if (!parsed.ok) return parsed.result;
        const description = asString(parsed.value.description);
        if (description !== null) repo.description = description;
        return respond(200, repoJson(repo));
      }
      if (m === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, headers: { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() }, body: Buffer.alloc(0) };
      }
      return err(404, 'Not Found');
    }

    // POST /git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
      if (m !== 'POST') return err(404, 'Not Found');
      const parsed = parseBody(body);
      if (!parsed.ok) return parsed.result;
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (ref === null || !ref.startsWith('refs/heads/') || ref === 'refs/heads/') {
        return err(422, 'ref must start with refs/heads/');
      }
      if (sha === null || !SHA40.test(sha)) return err(422, 'sha must be an existing commit');
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') return err(422, 'sha must be an existing commit');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return respond(201, { ref, object: { sha } });
    }

    // GET /branches
    if (tail.length === 1 && tail[0] === 'branches') {
      if (m !== 'GET') return err(404, 'Not Found');
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
      }
      return respond(200, branches);
    }

    // GET /commits
    if (tail.length === 1 && tail[0] === 'commits') {
      if (m !== 'GET') return err(404, 'Not Found');
      const shaParam = url.searchParams.get('sha');
      let oids: string[];
      if (shaParam === null || shaParam === '') {
        const tip = branchTip(repo, repo.defaultBranch);
        oids = tip === null ? [] : listBranchCommits(repo, repo.defaultBranch);
      } else if (repo.refs.has(`refs/heads/${shaParam}`)) {
        oids = listBranchCommits(repo, shaParam);
      } else if (repo.refs.has(shaParam)) {
        const tip = repo.refs.get(shaParam) as string;
        oids = walkFirstParent(repo, tip);
      } else if (SHA40.test(shaParam) && repo.objects.get(shaParam)?.type === 'commit') {
        oids = walkFirstParent(repo, shaParam);
      } else {
        return err(404, 'Not Found');
      }
      return respond(200, oids.map((oid) => ({ sha: oid, commit: { message: commitMessageOf(repo, oid) } })));
    }

    // /contents/{path...}
    if (tail.length >= 1 && tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      const refParam = url.searchParams.get('ref');
      if (m === 'PUT') {
        const parsed = parseBody(body);
        if (!parsed.ok) return parsed.result;
        const message = asString(parsed.value.message) ?? 'seeded commit';
        const contentB64 = asString(parsed.value.content);
        if (contentB64 === null) return err(422, 'content is required');
        if (!isValidBase64(contentB64)) return err(400, 'content is not valid base64');
        const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
        const givenSha = asString(parsed.value.sha);
        const currentSha = fileShaAtBranch(repo, branch, contentPath);
        if (givenSha !== null && givenSha !== currentSha) return err(409, 'sha does not match the current file');
        const isCreate = currentSha === null;
        const commitSha = commitFile(repo, branch, contentPath, bytes, message, AUTHOR_LINE, AUTHOR_LINE);
        const blobSha = hashObject('blob', bytes);
        return respond(isCreate ? 201 : 200, {
          content: { name: contentPath.split('/').pop() ?? '', path: contentPath, sha: blobSha, size: bytes.length, encoding: 'base64' },
          commit: { sha: commitSha },
        });
      }
      if (m === 'GET') {
        const tip = resolveTip(repo, refParam, repo.defaultBranch);
        if (tip === null) return err(404, 'Not Found');
        const treeOid = treeOfCommit(repo.objects, tip);
        if (treeOid === null) return err(404, 'Not Found');
        const flat = flattenTree(repo.objects, treeOid);
        const entry = flat.get(contentPath);
        if (entry !== undefined) {
          const blob = repo.objects.get(entry.oid);
          const data = blob !== undefined && blob.type === 'blob' ? blob.data : Buffer.alloc(0);
          return respond(200, {
            type: 'file',
            encoding: 'base64',
            content: data.toString('base64'),
            sha: entry.oid,
            size: data.length,
            name: contentPath.split('/').pop() ?? '',
            path: contentPath,
          });
        }
        // Directory? Any file below this path (or the root when path is empty).
        const prefix = contentPath === '' ? '' : `${contentPath}/`;
        const children = new Map<string, { kind: 'file' | 'dir'; oid: string; size: number }>();
        for (const [path, fileEntry] of flat) {
          if (!path.startsWith(prefix)) continue;
          const restPath = path.slice(prefix.length);
          const slash = restPath.indexOf('/');
          if (slash === -1) {
            const blob = repo.objects.get(fileEntry.oid);
            children.set(restPath, {
              kind: 'file',
              oid: fileEntry.oid,
              size: blob !== undefined && blob.type === 'blob' ? blob.data.length : 0,
            });
          } else {
            const dirName = restPath.slice(0, slash);
            if (!children.has(dirName)) {
              const sub = new Map<string, FlatEntry>();
              for (const [p2, e2] of flat) {
                if (p2.startsWith(`${prefix}${dirName}/`)) sub.set(p2.slice(`${prefix}${dirName}/`.length), e2);
              }
              children.set(dirName, { kind: 'dir', oid: buildTreeFromFlat(repo.objects, sub), size: 0 });
            }
          }
        }
        if (children.size === 0) return err(404, 'Not Found');
        const listing = [...children.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([name, child]) => ({
            type: child.kind,
            name,
            path: prefix === '' ? name : `${prefix}${name}`,
            sha: child.oid,
            ...(child.kind === 'file' ? { size: child.size } : {}),
          }));
        return respond(200, listing);
      }
      if (m === 'DELETE') {
        const parsed = parseBody(body);
        if (!parsed.ok) return parsed.result;
        const message = asString(parsed.value.message) ?? 'seeded commit';
        const givenSha = asString(parsed.value.sha);
        const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
        const tip = branchTip(repo, branch);
        if (tip === null) return err(404, 'Not Found');
        const currentSha = fileShaAtBranch(repo, branch, contentPath);
        if (currentSha === null) return err(404, 'Not Found');
        if (givenSha === null || givenSha !== currentSha) return err(409, 'sha does not match the current file');
        const treeOid = treeOfCommit(repo.objects, tip);
        if (treeOid === null) return err(404, 'Not Found');
        const flat = flattenTree(repo.objects, treeOid);
        flat.delete(contentPath);
        const commitSha = commitTree(repo, branch, flat, message);
        return respond(200, { commit: { sha: commitSha } });
      }
      return err(404, 'Not Found');
    }

    // POST /labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (m !== 'POST') return err(404, 'Not Found');
      const parsed = parseBody(body);
      if (!parsed.ok) return parsed.result;
      const name = asString(parsed.value.name);
      if (name === null || name.trim() === '') return err(422, 'name is required');
      const color = asString(parsed.value.color) ?? 'ededed';
      const label = store.createLabel(repo, name, color);
      return respond(201, { name: label.name, color: label.color });
    }

    // /issues...
    if (tail.length >= 1 && tail[0] === 'issues') {
      // POST /issues and GET /issues
      if (tail.length === 1) {
        if (m === 'POST') {
          const parsed = parseBody(body);
          if (!parsed.ok) return parsed.result;
          const title = asString(parsed.value.title);
          if (title === null || title === '') return err(422, 'title is required');
          const issueBody = asString(parsed.value.body) ?? '';
          const rawLabels = parsed.value.labels;
          const labels: string[] = [];
          if (rawLabels !== undefined) {
            if (!Array.isArray(rawLabels)) return err(422, 'labels must be an array');
            for (const item of rawLabels) {
              const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? asString((item as Record<string, unknown>).name) : null;
              if (name === null) return err(422, 'labels must be names');
              labels.push(name);
            }
          }
          for (const name of labels) {
            if (!repo.labels.has(name)) return err(422, `Label does not exist: ${name}`);
          }
          const issue = store.createIssue(repo, title, issueBody, labels);
          return respond(201, issueJson(repo, issue));
        }
        if (m === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const direction = url.searchParams.get('direction') ?? 'asc';
          const { perPage, page } = pagination(url);
          let items = [...repo.issues];
          if (state === 'open') items = items.filter((issue) => issue.state === 'open');
          else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
          else if (state !== 'all') items = items.filter((issue) => issue.state === 'open');
          if (sort === 'created' && direction === 'desc') items.sort((a, b) => b.number - a.number);
          else items.sort((a, b) => a.number - b.number);
          return respond(200, pageSlice(items, perPage, page).map((issue) => issueJson(repo, issue)));
        }
        return err(404, 'Not Found');
      }
      // /issues/{n} and /issues/{n}/comments
      const numRaw = tail[1] as string;
      if (!/^\d+$/.test(numRaw)) return err(404, 'Not Found');
      const issueNumber = Number.parseInt(numRaw, 10);
      const issue = store.getIssue(repo, issueNumber);
      if (issue === null) return err(404, 'Not Found');
      if (tail.length === 2) {
        if (m === 'GET') return respond(200, issueJson(repo, issue));
        if (m === 'PATCH') {
          const parsed = parseBody(body);
          if (!parsed.ok) return parsed.result;
          const state = asString(parsed.value.state);
          if (state !== null) {
            if (state !== 'open' && state !== 'closed') return err(422, 'state must be open or closed');
            issue.state = state;
          }
          return respond(200, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (m === 'POST') {
          const parsed = parseBody(body);
          if (!parsed.ok) return parsed.result;
          const commentBody = asString(parsed.value.body);
          if (commentBody === null) return err(422, 'body is required');
          const comment = store.addComment(repo, issue, commentBody);
          return respond(201, { id: comment.id, body: comment.body });
        }
        if (m === 'GET') {
          return respond(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /pulls...
    if (tail.length >= 1 && tail[0] === 'pulls') {
      // POST /pulls and GET /pulls
      if (tail.length === 1) {
        if (m === 'POST') {
          const parsed = parseBody(body);
          if (!parsed.ok) return parsed.result;
          const head = asString(parsed.value.head);
          const base = asString(parsed.value.base);
          const title = asString(parsed.value.title);
          const pullBody = asString(parsed.value.body) ?? '';
          if (head === null || head === '' || base === null || base === '') return err(422, 'head and base are required');
          if (title === null) return err(422, 'title is required');
          if (branchTip(repo, head) === null) return err(422, `Head branch does not exist: ${head}`);
          if (branchTip(repo, base) === null) return err(422, `Base branch does not exist: ${base}`);
          const pull = store.createPull(repo, title, pullBody, head, base);
          return respond(201, pullJson(repo, pull));
        }
        if (m === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const { perPage, page } = pagination(url);
          let items = [...repo.pulls].sort((a, b) => a.number - b.number);
          if (state === 'open') items = items.filter((pull) => pull.state === 'open');
          else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
          else if (state !== 'all') items = items.filter((pull) => pull.state === 'open');
          return respond(200, pageSlice(items, perPage, page).map((pull) => pullJson(repo, pull)));
        }
        return err(404, 'Not Found');
      }
      const numRaw = tail[1] as string;
      if (!/^\d+$/.test(numRaw)) return err(404, 'Not Found');
      const pullNumber = Number.parseInt(numRaw, 10);
      const pull = store.getPull(repo, pullNumber);
      if (pull === null) return err(404, 'Not Found');
      // GET /pulls/{n}/files
      if (tail.length === 3 && tail[2] === 'files') {
        if (m !== 'GET') return err(404, 'Not Found');
        const headTip = branchTip(repo, pull.head);
        const baseTip = branchTip(repo, pull.base);
        if (headTip === null || baseTip === null) return err(404, 'Not Found');
        const headTree = treeOfCommit(repo.objects, headTip) ?? ZERO_OID;
        const baseTree = treeOfCommit(repo.objects, baseTip) ?? ZERO_OID;
        const diff = diffTrees(repo.objects, baseTree, headTree);
        return respond(
          200,
          diff.map((entry) => ({
            filename: entry.path,
            status: entry.status,
            additions: entry.additions,
            deletions: entry.deletions,
            changes: entry.additions + entry.deletions,
          })),
        );
      }
      // PUT /pulls/{n}/merge
      if (tail.length === 3 && tail[2] === 'merge') {
        if (m !== 'PUT') return err(404, 'Not Found');
        if (hasBodyMethod && body.length > 0) {
          const parsed = parseBody(body);
          if (!parsed.ok) return parsed.result;
        }
        if (pull.state !== 'open' || pull.merged) return err(405, 'Pull request is already merged or closed');
        const headTip = branchTip(repo, pull.head);
        const baseTip = branchTip(repo, pull.base);
        if (headTip === null || baseTip === null) return err(422, 'Head or base branch does not exist');
        const baseOid = mergeBase(repo, headTip, baseTip);
        const headTree = treeOfCommit(repo.objects, headTip) ?? ZERO_OID;
        const baseTree = treeOfCommit(repo.objects, baseTip) ?? ZERO_OID;
        const mbTree = baseOid === null ? ZERO_OID : (treeOfCommit(repo.objects, baseOid) ?? ZERO_OID);
        const headFlat = flattenTree(repo.objects, headTree);
        const baseFlat = flattenTree(repo.objects, baseTree);
        const mbFlat = mbTree === ZERO_OID ? new Map<string, FlatEntry>() : flattenTree(repo.objects, mbTree);
        const changedOn = (from: Map<string, FlatEntry>, to: Map<string, FlatEntry>): Set<string> => {
          const out = new Set<string>();
          for (const [path, entry] of to) {
            if (from.get(path)?.oid !== entry.oid) out.add(path);
          }
          for (const path of from.keys()) {
            if (!to.has(path)) out.add(path);
          }
          return out;
        };
        const headChanged = changedOn(mbFlat, headFlat);
        const baseChanged = changedOn(mbFlat, baseFlat);
        for (const path of headChanged) {
          if (!baseChanged.has(path)) continue;
          if (headFlat.get(path)?.oid !== baseFlat.get(path)?.oid) {
            return err(405, 'Merge conflict');
          }
        }
        const mergedFlat = new Map<string, FlatEntry>(baseFlat);
        for (const path of headChanged) {
          const entry = headFlat.get(path);
          if (entry === undefined) mergedFlat.delete(path);
          else mergedFlat.set(path, entry);
        }
        const mergeSha = commitTree(repo, pull.base, mergedFlat, pull.title);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = FIXED_ISO;
        pull.mergeCommitSha = mergeSha;
        return respond(200, { merged: true, sha: mergeSha, message: `Merge pull request #${pull.number} from ${pull.head}` });
      }
      // GET /pulls/{n}
      if (tail.length === 2) {
        if (m !== 'GET') return err(404, 'Not Found');
        return respond(200, pullJson(repo, pull));
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
