// mcp.ts — Model Context Protocol surface (POST /mcp) for the forge entry.
//
// JSON-RPC 2.0 over Streamable HTTP, answered as plain application/json (never
// SSE). Speaks both eras the suite accepts: modern 2026-07-28 via
// `server/discover`, and legacy 2025-11-25 and earlier via `initialize` +
// `notifications/initialized`. Shares the store with REST/GraphQL, so ids are
// identical across surfaces.
//
// Handler contract (wired by app.ts):
//   handleMcpRequest(method, url, headers, body, store, isAuthed)
//     -> {status, headers, body} | null   (null = not our path/method)

import {
  FIXED_ISO,
  VIEWER_LOGIN,
  ZERO_OID,
  buildCommitBytes,
  buildTreeFromPaths,
  diffTrees,
  flattenTree,
  putObject,
  treeOfCommit,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface HandlerResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type AnyRecord = Record<string, unknown>;

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
const AUTHOR_LINE = 'ada iversen <adaiversen@example.invalid> 1735689600 +0000';
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function jsonResult(status: number, body: unknown, extraHeaders: Record<string, string> = {}): HandlerResult {
  return { status, headers: { ...JSON_HEADERS, ...extraHeaders }, body: JSON.stringify(body) };
}

function pathOf(url: string): string {
  try {
    return new URL(url, 'http://entry').pathname;
  } catch {
    return url;
  }
}

function bodyTextOf(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body !== null && typeof body === 'object') {
    try {
      return JSON.stringify(body);
    } catch {
      return '';
    }
  }
  return '';
}

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Squash merge (duplicated from the REST/GraphQL surfaces: same tree math,
// same fixed author line, same store mutations).
// ---------------------------------------------------------------------------

function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
  if (headTip === null || baseTip === null) return null;
  if (pull.merged && pull.mergeCommitSha !== null) return pull.mergeCommitSha;

  const headAncestors = new Set<string>();
  {
    const stack = [headTip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (headAncestors.has(oid)) continue;
      headAncestors.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const text = obj.data.toString('utf8');
      for (const m of text.matchAll(/^parent ([0-9a-f]{40})$/gm)) stack.push(m[1] as string);
    }
  }
  let mergeBase: string | null = null;
  {
    const queue = [baseTip];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (headAncestors.has(oid)) {
        mergeBase = oid;
        break;
      }
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const text = obj.data.toString('utf8');
      for (const m of text.matchAll(/^parent ([0-9a-f]{40})$/gm)) queue.push(m[1] as string);
    }
  }

  const baseTree = treeOfCommit(repo.objects, baseTip) ?? ZERO_OID;
  const headTree = treeOfCommit(repo.objects, headTip) ?? ZERO_OID;
  const mergeBaseTree = mergeBase === null ? ZERO_OID : (treeOfCommit(repo.objects, mergeBase) ?? ZERO_OID);
  const merged = baseTree === ZERO_OID ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo.objects, baseTree);
  const headFlat = headTree === ZERO_OID ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo.objects, headTree);
  for (const change of diffTrees(repo.objects, mergeBaseTree, headTree)) {
    if (change.status === 'deleted') merged.delete(change.path);
    else {
      const entry = headFlat.get(change.path);
      if (entry !== undefined) merged.set(change.path, entry);
    }
  }
  const newTree = buildTreeFromPaths(repo.objects, merged);
  const message = `Merge pull request #${pull.number} from ${pull.head}`;
  const commitOid = putObject(
    repo.objects,
    'commit',
    buildCommitBytes(newTree, [baseTip], AUTHOR_LINE, AUTHOR_LINE, message),
  );
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = commitOid;
  pull.state = 'closed';
  return commitOid;
}

// ---------------------------------------------------------------------------
// Tool list: a module-level const, serialised deterministically (fixed key
// order, no timestamps, no random ids) so two tools/list answers are
// byte-for-byte identical.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: [],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
      },
      required: [],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: [],
    },
  },
] as const;

const KNOWN_TOOLS = new Set<string>(['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']);

// ---------------------------------------------------------------------------
// Argument helpers.
// ---------------------------------------------------------------------------

function pickString(args: AnyRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function pickNumber(args: AnyRecord, keys: readonly string[]): number | null {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

/** Resolve owner/repo from owner+repo, full_name, or the common synonyms. */
function resolveRepoRef(args: AnyRecord): { owner: string; repo: string } | null {
  let owner = pickString(args, ['owner', 'owner_login', 'user_login', 'login', 'org', 'organization', 'user', 'owner_name']);
  let repo = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  const full = pickString(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if (full !== null && full.includes('/')) {
    const [o, r] = full.split('/', 2) as [string, string];
    if (owner === null && o !== '') owner = o;
    if (repo === null && r !== '') repo = r;
  }
  if (repo === null) return null;
  if (owner === null) owner = VIEWER_LOGIN;
  return { owner, repo };
}

function repoObject(repo: Repo): AnyRecord {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    default_branch: repo.defaultBranch,
    description: repo.description,
  };
}

/** A tool result envelope: the same object as text and as structured content. */
function toolOk(result: unknown): AnyRecord {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
}

function toolErr(message: string): AnyRecord {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Thrown for a tools/call that must answer a JSON-RPC error instead of a result. */
class RpcFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Tool implementations (all act on the shared store).
// ---------------------------------------------------------------------------

function callCreateRepo(store: Store, args: AnyRecord): AnyRecord {
  const name = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
  if (name === null) throw new RpcFailure(-32602, 'create_repo: missing required argument: name');
  const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
  const isPrivate = args.private === true || args.is_private === true;
  const existing = store.getRepo(VIEWER_LOGIN, name);
  const repo = existing ?? store.createRepo(name, description, isPrivate);
  if (repo === null) throw new RpcFailure(-32602, `create_repo: could not create repository "${name}"`);
  return toolOk(repoObject(repo));
}

function callGetRepo(store: Store, args: AnyRecord): AnyRecord {
  const ref = resolveRepoRef(args);
  if (ref === null) return toolErr('get_repo: could not resolve the repository (owner/repo or full_name is required)');
  const repo = store.getRepo(ref.owner, ref.repo);
  if (repo === null) return toolErr(`get_repo: repository ${ref.owner}/${ref.repo} not found`);
  return toolOk(repoObject(repo));
}

function callCreateIssue(store: Store, args: AnyRecord): AnyRecord {
  const title = pickString(args, ['title', 'issue_title', 'subject']);
  if (title === null) throw new RpcFailure(-32602, 'create_issue: missing required argument: title');
  const ref = resolveRepoRef(args);
  if (ref === null) return toolErr('create_issue: could not resolve the repository (owner/repo or full_name is required)');
  const repo = store.getRepo(ref.owner, ref.repo);
  if (repo === null) return toolErr(`create_issue: repository ${ref.owner}/${ref.repo} not found`);
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text']) ?? '';
  const issue = store.createIssue(repo, title, body, []);
  return toolOk({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: 'open', labels: [] });
}

function callListIssues(store: Store, args: AnyRecord): AnyRecord {
  const ref = resolveRepoRef(args);
  if (ref === null) return toolErr('list_issues: could not resolve the repository (owner/repo or full_name is required)');
  const repo = store.getRepo(ref.owner, ref.repo);
  if (repo === null) return toolErr(`list_issues: repository ${ref.owner}/${ref.repo} not found`);
  const state = pickString(args, ['state', 'status']);
  let issues = [...repo.issues];
  if (state !== null) {
    const wanted = state.toLowerCase();
    if (wanted === 'open' || wanted === 'closed') issues = issues.filter((i) => i.state === wanted);
  }
  const result = { issues: issues.map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state })) };
  return toolOk(result);
}

function callCreatePullRequest(store: Store, args: AnyRecord): AnyRecord {
  const title = pickString(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
  if (title === null) throw new RpcFailure(-32602, 'create_pull_request: missing required argument: title');
  const head = pickString(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
  if (head === null) throw new RpcFailure(-32602, 'create_pull_request: missing required argument: head');
  const base = pickString(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']) ?? 'main';
  const ref = resolveRepoRef(args);
  if (ref === null) return toolErr('create_pull_request: could not resolve the repository (owner/repo or full_name is required)');
  const repo = store.getRepo(ref.owner, ref.repo);
  if (repo === null) return toolErr(`create_pull_request: repository ${ref.owner}/${ref.repo} not found`);
  const headSha = repo.refs.get(`refs/heads/${head}`) ?? null;
  if (headSha === null) return toolErr(`create_pull_request: head branch "${head}" does not exist`);
  const baseSha = repo.refs.get(`refs/heads/${base}`) ?? ZERO_OID;
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text']) ?? '';
  const pull = store.createPull(repo, title, body, head, base);
  return toolOk({
    number: pull.number,
    state: 'open',
    title: pull.title,
    body: pull.body,
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
  });
}

function callMergePullRequest(store: Store, args: AnyRecord): AnyRecord {
  const number = pickNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  if (number === null) throw new RpcFailure(-32602, 'merge_pull_request: missing required argument: pull_number');
  const ref = resolveRepoRef(args);
  if (ref === null) return toolErr('merge_pull_request: could not resolve the repository (owner/repo or full_name is required)');
  const repo = store.getRepo(ref.owner, ref.repo);
  if (repo === null) return toolErr(`merge_pull_request: repository ${ref.owner}/${ref.repo} not found`);
  const pull = store.getPull(repo, number);
  if (pull === null) return toolErr(`merge_pull_request: pull request #${number} not found`);
  if (pull.merged && pull.mergeCommitSha !== null) {
    return toolOk({ merged: true, sha: pull.mergeCommitSha, number: pull.number, state: 'closed' });
  }
  const sha = squashMerge(store, repo, pull);
  if (sha === null) return toolErr(`merge_pull_request: could not merge pull request #${number} (missing branch tip)`);
  return toolOk({ merged: true, sha, number: pull.number, state: 'closed' });
}

function callTool(store: Store, name: string, args: AnyRecord): AnyRecord {
  switch (name) {
    case 'create_repo':
      return callCreateRepo(store, args);
    case 'get_repo':
      return callGetRepo(store, args);
    case 'create_issue':
      return callCreateIssue(store, args);
    case 'list_issues':
      return callListIssues(store, args);
    case 'create_pull_request':
      return callCreatePullRequest(store, args);
    case 'merge_pull_request':
      return callMergePullRequest(store, args);
    default:
      throw new RpcFailure(-32602, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

export async function handleMcpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  store: Store,
  isAuthed: boolean,
): Promise<HandlerResult | null> {
  if (pathOf(url) !== '/mcp') return null;
  // A legacy client closes its session with DELETE; answer it and move on.
  if (method === 'DELETE') return { status: 200, headers: {}, body: '' };
  if (method !== 'POST') return null;

  const lower = lowerHeaders(headers);
  const extra: Record<string, string> = {};
  if (lower['mcp-session-id'] !== undefined) extra['mcp-session-id'] = lower['mcp-session-id'] as string;

  if (!isAuthed) return jsonResult(401, { message: 'Unauthorized' }, extra);

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyTextOf(body));
  } catch {
    return jsonResult(
      400,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      extra,
    );
  }

  if (Array.isArray(parsed)) {
    return jsonResult(
      400,
      { jsonrpc: '2.0', id: null, error: { code: -32602, message: 'Invalid params: batch requests are not supported' } },
      extra,
    );
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    const id = isRecord(parsed) && 'id' in parsed ? (parsed.id as string | number | null) : null;
    return jsonResult(
      200,
      { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: 'Invalid params: a method is required' } },
      extra,
    );
  }

  const id = 'id' in parsed ? (parsed.id as string | number | null) : undefined;
  const requestMethod = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};

  // A notification carries no id and gets no response body at all.
  if (id === undefined || id === null) {
    return { status: 202, headers: {}, body: '' };
  }

  const ok = (result: unknown): HandlerResult => jsonResult(200, { jsonrpc: '2.0', id, result }, extra);
  const fail = (code: number, message: string): HandlerResult =>
    jsonResult(200, { jsonrpc: '2.0', id, error: { code, message } }, extra);

  switch (requestMethod) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return ok({
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = requested !== '' && requested <= '2025-11-25' ? requested : '2025-11-25';
      return ok({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (!KNOWN_TOOLS.has(name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        return ok(callTool(store, name, args));
      } catch (err) {
        if (err instanceof RpcFailure) return fail(err.code, err.message);
        return fail(-32603, err instanceof Error ? err.message : String(err));
      }
    }
    default:
      return fail(-32601, `Method not found: ${requestMethod}`);
  }
}
