// graphql.ts — GitHub GraphQL v4 surface (POST /api/graphql) for the forge entry.
//
// A small, dependency-free GraphQL parser + executor covering exactly the
// documents the conformance suite sends (see kit checks-graphql.ts): viewer /
// repository / node reads, issue & pull-request connections with cursor
// pagination, __type/__schema introspection, and the create/close/merge/
// comment mutations. Shares the store with REST/MCP, so ids are identical
// across surfaces.
//
// Handler contract (wired by app.ts):
//   handleGraphqlRequest(method, url, headers, body, store, isAuthed)
//     -> {status, headers, body} | null   (null = not our path/method)

import {
  FIXED_ISO,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  ZERO_OID,
  buildCommitBytes,
  buildTreeFromPaths,
  commentGlobalId,
  decodeGlobalId,
  diffTrees,
  flattenTree,
  issueGlobalId,
  pullGlobalId,
  putObject,
  repoGlobalId,
  treeOfCommit,
  type Issue,
  type IssueComment,
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

// ---------------------------------------------------------------------------
// Squash merge (duplicated from the REST surface's merge: same tree math, same
// fixed author line, same store mutations, so every surface reads merged:true
// and state closed afterwards).
// ---------------------------------------------------------------------------

function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
  if (headTip === null || baseTip === null) return null;
  if (pull.merged && pull.mergeCommitSha !== null) return pull.mergeCommitSha;

  // Merge base: first ancestor of the base tip that is also an ancestor of the head tip.
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
// GraphQL lexer / parser (subset: the documents the suite sends).
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < input.length) {
        const ch = input[j] as string;
        if (ch === '"') {
          closed = true;
          break;
        }
        if (ch === '\\') {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
          continue;
        }
        out += ch;
        j += 1;
      }
      if (!closed) throw new Error('Syntax Error: unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Syntax Error: unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet?: SelectionNode[];
}
interface SpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selectionSet: SelectionNode[];
}
type SelectionNode = FieldNode | SpreadNode | InlineFragmentNode;

interface VarDef {
  name: string;
  defaultValue?: ValueNode;
}
interface OperationDef {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  varDefs: VarDef[];
  selectionSet: SelectionNode[];
}
interface FragmentDef {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}
type Definition = OperationDef | FragmentDef;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const t = this.tokens[this.pos] as Token;
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`Syntax Error: expected "${value}" but got "${t.value}"`);
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Syntax Error: expected a name but got "${t.value}"`);
    if (value !== undefined && t.value !== value) throw new Error(`Syntax Error: expected "${value}" but got "${t.value}"`);
    return t.value;
  }
  private isPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }

  parseDocument(): Definition[] {
    const defs: Definition[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): Definition {
    if (this.isPunct('{')) return { kind: 'operation', operation: 'query', varDefs: [], selectionSet: this.parseSelectionSet() };
    const keyword = this.expectName();
    if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value;
      const varDefs = this.isPunct('(') ? this.parseVarDefs() : [];
      this.skipDirectives();
      return { kind: 'operation', operation: keyword, name, varDefs, selectionSet: this.parseSelectionSet() };
    }
    if (keyword === 'fragment') {
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`Syntax Error: unexpected definition "${keyword}"`);
  }

  private parseVarDefs(): VarDef[] {
    this.expectPunct('(');
    const defs: VarDef[] = [];
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.skipDirectives();
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArgs();
    }
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new Error('Syntax Error: variable in a constant value');
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') {
      this.next();
      return { kind: 'string', value: t.value };
    }
    if (t.kind === 'int') {
      this.next();
      return { kind: 'int', value: parseInt(t.value, 10) };
    }
    if (t.kind === 'float') {
      this.next();
      return { kind: 'float', value: parseFloat(t.value) };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Syntax Error: unexpected value token "${t.value}"`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value !== 'on') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      let typeCondition: string | undefined;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArgs() : [];
    this.skipDirectives();
    const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, selectionSet };
  }
}

// ---------------------------------------------------------------------------
// Executor: resolved nodes carry a __typename and field values that are either
// plain values or (args) => value thunks, so arg-taking fields resolve lazily.
// ---------------------------------------------------------------------------

interface GNode {
  __typename: string;
  fields: Record<string, unknown>;
}
type FieldThunk = (args: AnyRecord) => unknown;

function node(typename: string, fields: Record<string, unknown>): GNode {
  return { __typename: typename, fields };
}

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const m = /^cursor:(\d+)$/.exec(cursor);
  if (m === null) {
    const n = Number(cursor);
    return Number.isInteger(n) ? n : null;
  }
  return Number(m[1]);
}

interface ExecCtx {
  store: Store;
  errors: Array<{ message: string; path?: Array<string | number> }>;
  fragments: Map<string, FragmentDef>;
  variables: AnyRecord;
}

function resolveValue(valueNode: ValueNode, variables: AnyRecord): unknown {
  switch (valueNode.kind) {
    case 'variable':
      return variables[valueNode.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return valueNode.value;
    case 'null':
      return null;
    case 'enum':
      return valueNode.value;
    case 'list':
      return valueNode.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: AnyRecord = {};
      for (const f of valueNode.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function executeSelectionSet(ctx: ExecCtx, obj: GNode, selections: SelectionNode[], path: Array<string | number>): AnyRecord {
  const out: AnyRecord = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag !== undefined && frag.typeCondition === obj.__typename) {
        Object.assign(out, executeSelectionSet(ctx, obj, frag.selectionSet, path));
      }
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition === undefined || sel.typeCondition === obj.__typename) {
        Object.assign(out, executeSelectionSet(ctx, obj, sel.selectionSet, path));
      }
      continue;
    }
    const outKey = sel.alias ?? sel.name;
    const fieldPath = [...path, outKey];
    if (sel.name === '__typename') {
      out[outKey] = obj.__typename;
      continue;
    }
    const raw = obj.fields[sel.name];
    if (raw === undefined) {
      ctx.errors.push({
        message: `Cannot query field "${sel.name}" on type "${obj.__typename}".`,
        path: fieldPath,
      });
      out[outKey] = null;
      continue;
    }
    let value: unknown;
    try {
      const args: AnyRecord = {};
      for (const a of sel.args) args[a.name] = resolveValue(a.value, ctx.variables);
      value = typeof raw === 'function' ? (raw as FieldThunk)(args) : raw;
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[outKey] = null;
      continue;
    }
    out[outKey] = executeValue(ctx, value, sel.selectionSet, fieldPath);
  }
  return out;
}

function executeValue(ctx: ExecCtx, value: unknown, selectionSet: SelectionNode[] | undefined, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v, i) => executeValue(ctx, v, selectionSet, [...path, i]));
  if (isRecord(value) && '__typename' in value && 'fields' in value) {
    const nodeValue = value as unknown as GNode;
    if (selectionSet === undefined) return {};
    return executeSelectionSet(ctx, nodeValue, selectionSet, path);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Resolvers: build the node graph out of the store.
// ---------------------------------------------------------------------------

function userNode(): GNode {
  return node('User', { login: VIEWER_LOGIN, id: VIEWER_ID, databaseId: VIEWER_ID, name: VIEWER_NAME });
}

function refNode(name: string): GNode {
  return node('Ref', { name });
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): GNode {
  return node('PageInfo', { hasNextPage, hasPreviousPage: false, startCursor, endCursor });
}

function labelNode(name: string): GNode {
  return node('Label', { name, color: '000000' });
}

function commentNode(repo: Repo, comment: IssueComment): GNode {
  return node('IssueComment', {
    id: commentGlobalId(repo, comment),
    body: comment.body,
    author: userNode(),
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  });
}

function issueNode(repo: Repo, issue: Issue): GNode {
  return node('Issue', {
    id: issueGlobalId(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: userNode(),
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    labels: ((args: AnyRecord) => {
      const first = typeof args.first === 'number' ? args.first : issue.labels.length;
      const names = issue.labels.slice(0, first);
      return node('LabelConnection', {
        nodes: names.map((n) => labelNode(n)),
        totalCount: issue.labels.length,
        pageInfo: pageInfoNode(false, null, null),
      });
    }) as FieldThunk,
    comments: ((args: AnyRecord) => {
      const first = typeof args.first === 'number' ? args.first : issue.comments.length;
      const shown = issue.comments.slice(0, first);
      return node('IssueCommentConnection', {
        nodes: shown.map((c) => commentNode(repo, c)),
        totalCount: issue.comments.length,
        pageInfo: pageInfoNode(issue.comments.length > shown.length, null, null),
      });
    }) as FieldThunk,
  });
}

function changedFileNode(path: string): GNode {
  return node('PullRequestChangedFile', { path });
}

function pullNode(repo: Repo, pull: Pull): GNode {
  return node('PullRequest', {
    id: pullGlobalId(repo, pull),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: repo.refs.get(`refs/heads/${pull.head}`) ?? null,
    baseRefOid: repo.refs.get(`refs/heads/${pull.base}`) ?? null,
    mergeable: pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN',
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    author: userNode(),
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    files: ((args: AnyRecord) => {
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
      const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
      const baseTree = baseTip === null ? ZERO_OID : (treeOfCommit(repo.objects, baseTip) ?? ZERO_OID);
      const headTree = headTip === null ? ZERO_OID : (treeOfCommit(repo.objects, headTip) ?? ZERO_OID);
      const diff = diffTrees(repo.objects, baseTree, headTree);
      const first = typeof args.first === 'number' ? args.first : diff.length;
      const shown = diff.slice(0, first);
      return node('PullRequestChangedFileConnection', {
        nodes: shown.map((d) => changedFileNode(d.path)),
        totalCount: diff.length,
        pageInfo: pageInfoNode(diff.length > shown.length, null, null),
      });
    }) as FieldThunk,
  });
}

function issueConnection(repo: Repo, args: AnyRecord): GNode {
  let list = [...repo.issues];
  const states = asStringArray(args.states);
  if (states.length > 0) {
    const wanted = new Set(states.map((s) => s.toUpperCase()));
    list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const totalCount = list.length;
  const afterNum = decodeCursor(args.after);
  if (afterNum !== null) list = list.filter((i) => (direction === 'ASC' ? i.number > afterNum : i.number < afterNum));
  const first = typeof args.first === 'number' ? args.first : list.length;
  const shown = list.slice(0, first);
  const hasNextPage = list.length > shown.length;
  const endCursor = shown.length > 0 ? `cursor:${(shown[shown.length - 1] as Issue).number}` : null;
  const startCursor = shown.length > 0 ? `cursor:${(shown[0] as Issue).number}` : null;
  return node('IssueConnection', {
    nodes: shown.map((i) => issueNode(repo, i)),
    totalCount,
    pageInfo: pageInfoNode(hasNextPage, endCursor, startCursor),
  });
}

function pullConnection(repo: Repo, args: AnyRecord): GNode {
  let list = [...repo.pulls];
  const states = asStringArray(args.states);
  if (states.length > 0) {
    const wanted = new Set(states.map((s) => s.toUpperCase()));
    list = list.filter((p) => {
      const gql = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(gql);
    });
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const totalCount = list.length;
  const afterNum = decodeCursor(args.after);
  if (afterNum !== null) list = list.filter((p) => (direction === 'ASC' ? p.number > afterNum : p.number < afterNum));
  const first = typeof args.first === 'number' ? args.first : list.length;
  const shown = list.slice(0, first);
  const hasNextPage = list.length > shown.length;
  const endCursor = shown.length > 0 ? `cursor:${(shown[shown.length - 1] as Pull).number}` : null;
  const startCursor = shown.length > 0 ? `cursor:${(shown[0] as Pull).number}` : null;
  return node('PullRequestConnection', {
    nodes: shown.map((p) => pullNode(repo, p)),
    totalCount,
    pageInfo: pageInfoNode(hasNextPage, endCursor, startCursor),
  });
}

function repoNode(repo: Repo): GNode {
  return node('Repository', {
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    description: repo.description,
    isPrivate: repo.private,
    owner: userNode(),
    defaultBranchRef: refNode(repo.defaultBranch),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    issue: ((args: AnyRecord) => {
      const issue = repo.issues.find((i) => i.number === Number(args.number)) ?? null;
      return issue === null ? null : issueNode(repo, issue);
    }) as FieldThunk,
    issues: ((args: AnyRecord) => issueConnection(repo, args)) as FieldThunk,
    pullRequests: ((args: AnyRecord) => pullConnection(repo, args)) as FieldThunk,
    pullRequest: ((args: AnyRecord) => {
      const pull = repo.pulls.find((p) => p.number === Number(args.number)) ?? null;
      return pull === null ? null : pullNode(repo, pull);
    }) as FieldThunk,
  });
}

// ---- introspection ----------------------------------------------------------

const TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'], enumValues: [] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'], enumValues: [] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    enumValues: [],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt'], enumValues: [] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt', 'updatedAt'],
    enumValues: [],
  },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'databaseId', 'name'], enumValues: [] },
  Ref: { kind: 'OBJECT', fields: ['name'], enumValues: [] },
  Label: { kind: 'OBJECT', fields: ['name', 'color'], enumValues: [] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt'], enumValues: [] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount', 'pageInfo'], enumValues: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount', 'pageInfo'], enumValues: [] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount', 'pageInfo'], enumValues: [] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount', 'pageInfo'], enumValues: [] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount', 'pageInfo'], enumValues: [] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'], enumValues: [] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
};

function typeNode(name: string): GNode | null {
  const info = TYPE_INFO[name];
  if (info === undefined) return null;
  return node('__Type', {
    name,
    kind: info.kind,
    description: null,
    fields: ((/* args */) => info.fields.map((f) => node('__Field', { name: f, description: null, args: [], type: null }))) as FieldThunk,
    enumValues: ((/* args */) => info.enumValues.map((v) => node('__EnumValue', { name: v, description: null }))) as FieldThunk,
  });
}

function schemaNode(): GNode {
  return node('__Schema', {
    types: Object.keys(TYPE_INFO).map((n) => typeNode(n) as GNode),
    queryType: typeNode('Query') as GNode,
    mutationType: typeNode('Mutation') as GNode,
    description: null,
  });
}

// ---- mutation payloads ------------------------------------------------------

function payloadNode(typename: string, fields: Record<string, unknown>): GNode {
  return node(typename, fields);
}

function decodeRepoIssue(store: Store, globalId: string): { repo: Repo; issue: Issue } | null {
  const dec = decodeGlobalId(globalId);
  if (dec === null || dec.kind !== 'Issue') return null;
  const repo = store.repoById(Math.floor(dec.numericId / 1_000_000));
  if (repo === null) return null;
  const issue = repo.issues.find((i) => i.number === dec.numericId % 1_000_000) ?? null;
  if (issue === null) return null;
  return { repo, issue };
}

function decodeRepoPull(store: Store, globalId: string): { repo: Repo; pull: Pull } | null {
  const dec = decodeGlobalId(globalId);
  if (dec === null || dec.kind !== 'PullRequest') return null;
  const repo = store.repoById(Math.floor(dec.numericId / 1_000_000));
  if (repo === null) return null;
  const pull = repo.pulls.find((p) => p.number === dec.numericId % 1_000_000) ?? null;
  if (pull === null) return null;
  return { repo, pull };
}

function queryRoot(store: Store): GNode {
  return node('Query', {
    viewer: userNode(),
    repository: ((args: AnyRecord) => {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : repoNode(repo);
    }) as FieldThunk,
    node: ((args: AnyRecord) => {
      const dec = decodeGlobalId(String(args.id ?? ''));
      if (dec === null) return null;
      if (dec.kind === 'Repository') {
        const repo = store.repoById(dec.numericId);
        return repo === null ? null : repoNode(repo);
      }
      if (dec.kind === 'Issue') {
        const found = decodeRepoIssue(store, String(args.id ?? ''));
        return found === null ? null : issueNode(found.repo, found.issue);
      }
      if (dec.kind === 'PullRequest') {
        const found = decodeRepoPull(store, String(args.id ?? ''));
        return found === null ? null : pullNode(found.repo, found.pull);
      }
      return null;
    }) as FieldThunk,
    __type: ((args: AnyRecord) => typeNode(String(args.name ?? ''))) as FieldThunk,
    __schema: schemaNode(),
  });
}

function mutationRoot(store: Store): GNode {
  return node('Mutation', {
    createIssue: ((args: AnyRecord) => {
      const input = isRecord(args.input) ? args.input : {};
      const dec = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = dec !== null && dec.kind === 'Repository' ? store.repoById(dec.numericId) : null;
      if (repo === null) throw new Error('createIssue: repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return payloadNode('CreateIssuePayload', {
        issue: issueNode(repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      });
    }) as FieldThunk,
    closeIssue: ((args: AnyRecord) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = decodeRepoIssue(store, String(input.issueId ?? ''));
      if (found === null) throw new Error('closeIssue: issue not found');
      found.issue.state = 'closed';
      return payloadNode('CloseIssuePayload', {
        issue: issueNode(found.repo, found.issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      });
    }) as FieldThunk,
    createPullRequest: ((args: AnyRecord) => {
      const input = isRecord(args.input) ? args.input : {};
      const dec = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = dec !== null && dec.kind === 'Repository' ? store.repoById(dec.numericId) : null;
      if (repo === null) throw new Error('createPullRequest: repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!repo.refs.has(`refs/heads/${head}`)) throw new Error(`createPullRequest: head branch "${head}" does not exist`);
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const pull = store.createPull(repo, title, body, head, base);
      return payloadNode('CreatePullRequestPayload', {
        pullRequest: pullNode(repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      });
    }) as FieldThunk,
    mergePullRequest: ((args: AnyRecord) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = decodeRepoPull(store, String(input.pullRequestId ?? ''));
      if (found === null) throw new Error('mergePullRequest: pull request not found');
      // mergeMethod is accepted in any casing ("SQUASH"/"squash"); only squash is implemented.
      if (!found.pull.merged) {
        const sha = squashMerge(store, found.repo, found.pull);
        if (sha === null) throw new Error('mergePullRequest: cannot merge (missing branch tip)');
      }
      return payloadNode('MergePullRequestPayload', {
        pullRequest: pullNode(found.repo, found.pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      });
    }) as FieldThunk,
    addComment: ((args: AnyRecord) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = decodeRepoIssue(store, String(input.subjectId ?? ''));
      if (found === null) throw new Error('addComment: subject not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = store.addComment(found.repo, found.issue, body);
      const commentGNode = commentNode(found.repo, comment);
      return payloadNode('AddCommentPayload', {
        commentEdge: node('IssueCommentEdge', { node: commentGNode, cursor: `cursor:${comment.id}` }),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      });
    }) as FieldThunk,
  });
}

// ---------------------------------------------------------------------------
// One operation.
// ---------------------------------------------------------------------------

function executeOperation(store: Store, op: OperationDef, fragments: Map<string, FragmentDef>, variables: AnyRecord): { data: AnyRecord | null; errors: Array<{ message: string; path?: Array<string | number> }> } {
  const vars: AnyRecord = {};
  for (const def of op.varDefs) {
    if (Object.prototype.hasOwnProperty.call(variables, def.name) && variables[def.name] !== undefined) {
      vars[def.name] = variables[def.name];
    } else if (def.defaultValue !== undefined) {
      vars[def.name] = resolveValue(def.defaultValue, vars);
    }
  }
  const ctx: ExecCtx = { store, errors: [], fragments, variables: vars };
  const root = op.operation === 'mutation' ? mutationRoot(store) : queryRoot(store);
  const data = executeSelectionSet(ctx, root, op.selectionSet, []);
  return { data, errors: ctx.errors };
}

function runDocument(store: Store, query: string, variables: AnyRecord, operationName?: string): { data: AnyRecord | null; errors: Array<{ message: string; path?: Array<string | number> }> } {
  let definitions: Definition[];
  try {
    definitions = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragmentDef>();
  const operations: OperationDef[] = [];
  for (const def of definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else operations.push(def);
  }
  let op: OperationDef | undefined;
  if (operationName !== undefined) {
    op = operations.find((o) => o.name === operationName);
    if (op === undefined) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (operations.length === 1) {
    op = operations[0];
  } else if (operations.length === 0) {
    return { data: null, errors: [{ message: 'Syntax Error: no operation in document' }] };
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  return executeOperation(store, op as OperationDef, fragments, variables);
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

export async function handleGraphqlRequest(
  method: string,
  url: string,
  _headers: Record<string, string>,
  body: unknown,
  store: Store,
  isAuthed: boolean,
): Promise<HandlerResult | null> {
  if (pathOf(url) !== '/api/graphql') return null;
  if (method !== 'POST') return null;
  if (!isAuthed) return jsonResult(401, { message: 'Requires authentication' });

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyTextOf(body));
  } catch {
    return jsonResult(400, { errors: [{ message: 'Malformed JSON body' }] });
  }

  const runOne = (entry: unknown): { data: AnyRecord | null; errors: Array<{ message: string; path?: Array<string | number> }> } => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'Request must carry a query string' }] };
    }
    const variables = isRecord(entry.variables) ? entry.variables : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
    return runDocument(store, entry.query, variables, operationName);
  };

  if (Array.isArray(parsed)) {
    return jsonResult(200, parsed.map((entry) => runOne(entry)));
  }
  if (isRecord(parsed)) {
    return jsonResult(200, runOne(parsed));
  }
  return jsonResult(400, { errors: [{ message: 'Malformed JSON body' }] });
}
