// git.ts — the git smart-HTTP surface for the forge entry.
//
// Protocol v2 + v0 for git-upload-pack (info/refs advertisement, ls-refs, fetch),
// protocol v0 only for git-receive-pack (advertisement, push with report-status).
//
// Only the shared store's helpers are used for object/reachability work, plus
// node:crypto (SHA-1) and node:zlib (pack inflate/deflate). No git binary, no npm,
// no outside services. Packs the server sends are plain (undeltified) objects;
// packs the server receives may carry OFS_DELTA / REF_DELTA entries, which are
// resolved here (bases: earlier pack entries, or objects the server already holds).
//
// The entry's app.ts calls handleGitRequest and falls through to its own routing
// when it returns null (the path is not a git route). This module never throws
// out of handleGitRequest: a malformed git body is a 400, anything unexpected
// is a 500, and the store is never left half-updated by a bad request.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
} from './store.ts';
import type { GitObject, GitObjectType, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------
// result type + errors
// ---------------------------------------------------------------------------

/** What handleGitRequest returns for a git route (null when it is not one). */
export interface GitHandlerResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** A request that is framed as git but is not well formed: answer 400, change nothing. */
class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

function bad(message: string): BadRequest {
  return new BadRequest(message);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const AGENT = 'makefun-git/1.0';
/** Largest pkt-line payload (length minus the 4-byte header). */
const PKT_MAX_PAYLOAD = 65516;

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Read one header, tolerating a web Headers object or a plain node header record. */
function getHeader(headers: Headers, name: string): string | null {
  const holder = headers as unknown as { get?: unknown };
  if (typeof holder.get === 'function') {
    try {
      const value = (holder.get as (n: string) => unknown).call(headers, name);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers as unknown as Record<string, unknown>)) {
    if (key.toLowerCase() !== lower) continue;
    const value = (headers as unknown as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0] as string;
  }
  return null;
}

function jsonResult(status: number, body: unknown): GitHandlerResult {
  const text = `${JSON.stringify(body)}\n`;
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) },
    body: Buffer.from(text, 'utf8'),
  };
}

function gitResult(status: number, contentType: string, body: Buffer): GitHandlerResult {
  return {
    status,
    headers: { 'content-type': contentType, 'content-length': String(body.length) },
    body,
  };
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

/** One pkt-line: 4 lowercase-hex length bytes (payload + 4) then the payload. */
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw bad(`pkt-line payload is ${data.length} bytes, over the maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Split data into sideband packets (first payload byte is the band), each within the pkt-line limit. */
function sidebandPackets(data: Buffer, band: number): Buffer[] {
  const out: Buffer[] = [];
  const chunk = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < data.length; offset += chunk) {
    const slice = data.subarray(offset, Math.min(data.length, offset + chunk));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return out;
}

/** Incremental pkt-line reader over a request body. `rest()` is the raw tail (a packfile). */
class PktReader {
  private readonly buf: Buffer;
  private pos = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  next(): { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' } | null {
    if (this.pos >= this.buf.length) return null;
    if (this.pos + 4 > this.buf.length) throw bad('truncated pkt-line');
    const head = this.buf.subarray(this.pos, this.pos + 4).toString('ascii');
    if (!HEX4.test(head)) throw bad(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      this.pos += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.pos += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.pos += 4;
      return { kind: 'response-end' };
    }
    if (length === 3 || length > 65520) throw bad(`invalid pkt-line length ${length}`);
    if (this.pos + length > this.buf.length) throw bad('truncated pkt-line');
    const payload = this.buf.subarray(this.pos + 4, this.pos + length);
    this.pos += length;
    return { kind: 'data', payload };
  }

  /** Every data packet's text, in order, until a flush / end-of-body (delims skipped). */
  linesUntilFlush(): string[] {
    const lines: string[] = [];
    for (;;) {
      const packet = this.next();
      if (packet === null || packet.kind === 'flush') return lines;
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    }
  }

  rest(): Buffer {
    return this.buf.subarray(this.pos);
  }
}

// ---------------------------------------------------------------------------
// packfile write (plain objects only, PACK v2)
// ---------------------------------------------------------------------------

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a PACK v2 from plain objects; each object is deflated exactly once. */
function buildPack(objects: ReadonlyMap<string, GitObject>): Buffer {
  const list = [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const [, object] of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// packfile read (plain + OFS_DELTA + REF_DELTA)
// ---------------------------------------------------------------------------

/** Inflate one zlib stream starting at `offset` (bounded by `end`); reports bytes consumed. */
function inflateAt(buffer: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset, end), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw bad(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw bad(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw bad('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw bad('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw bad(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw bad('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw bad('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw bad('delta copy is out of the base');
      if (written + copySize > targetSize) throw bad('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw bad('delta insert is truncated');
      if (written + literal > targetSize) throw bad('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw bad('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw bad(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: { type: GitObjectType; data: Buffer; oid: string };
}

/**
 * Parse a packfile (version 2 or 3) into its objects, resolving deltas. Bases may
 * be earlier pack entries or objects the server already holds. Throws BadRequest
 * on any malformed pack; the caller stores nothing in that case.
 */
function readPack(pack: Buffer, repo: Repo): Map<string, GitObject> {
  if (pack.length < 32) throw bad(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw bad('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw bad(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw bad('pack trailer does not match its bytes');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw bad('pack entry has no size header');
    let byte = pack[offset] as number;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw bad('pack entry size varint is truncated');
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw bad('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw bad('ofs-delta has no base offset');
      byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw bad('ofs-delta base offset is truncated');
        byte = pack[offset] as number;
        offset += 1;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw bad('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw bad('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw bad(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== size) {
      throw bad(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw bad(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const resolvedByOid = new Map<string, { type: GitObjectType; data: Buffer }>();
  const resolving = new Set<number>();

  const resolveByOid = (oid: string): { type: GitObjectType; data: Buffer } | null => {
    const fromPack = resolvedByOid.get(oid);
    if (fromPack) return fromPack;
    const held = repo.objects.get(oid);
    if (held) return { type: held.type, data: held.data };
    for (const candidate of raw) {
      if (candidate.resolved) continue;
      resolve(candidate);
      const found = resolvedByOid.get(oid);
      if (found) return found;
    }
    return null;
  };

  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw bad(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw bad(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const base = resolveByOid(entry.baseOid as string);
      if (!base) throw bad(`ref-delta base ${entry.baseOid} is neither in the pack nor held by the server`);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    entry.resolved = out;
    resolvedByOid.set(oid, out);
    resolving.delete(entry.offset);
    return out;
  };

  const objects = new Map<string, GitObject>();
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// repo helpers
// ---------------------------------------------------------------------------

/** The tip of refs/heads/main, or null when the branch is unborn. */
function headTipOid(repo: Repo): string | null {
  return repo.refs.get('refs/heads/main') ?? null;
}

/** The `object` header of a tag object, or null. */
function tagTargetOid(data: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match ? (match[1] as string) : null;
}

/**
 * Follow a tag chain to its non-tag target (the peeled oid), or null when `oid`
 * is not a tag object at all.
 */
function peelOid(repo: Repo, oid: string): string | null {
  const first = repo.objects.get(oid);
  if (!first || first.type !== 'tag') return null;
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    const target = tagTargetOid(object.data);
    if (!target) return null;
    current = target;
  }
}

/** Sorted refs, each with its oid. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------------------
// fetch planning (shared by v2 and v0)
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send (never anything reachable from a non-shallow have). */
  send: Map<string, GitObject>;
  /** New shallow boundary commits (depth-limited fetches). */
  shallow: string[];
  /** Former shallow boundaries that are now fully held. */
  unshallow: string[];
  /** Haves that are ancestors-or-equal of a want. */
  acks: string[];
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depthLimit: number | null,
): FetchPlan {
  const clean = (oids: readonly string[]): string[] => oids.filter((oid) => HEX40.test(oid));
  const wantOids = clean(wants);
  const haveOids = clean(haves);
  const shallowSet = new Set(clean(clientShallow));

  // A have that the client itself marks shallow is an edge commit: the client
  // holds the commit but not its parents, so its ancestry is NOT excluded.
  // Both full-ancestry walks are skipped when there is nothing to exclude or
  // acknowledge (the common case: a fresh clone with no haves). Walking the
  // whole 200-commit history just to learn the ACK set is empty is the clone
  // workload's hot path.
  const effectiveHaves = haveOids.filter((oid) => !shallowSet.has(oid));
  const excluded = effectiveHaves.length > 0 ? collectReachable(repo.objects, effectiveHaves) : new Set<string>();
  // ACKs: haves that are ancestors-or-equal of a want (shallow or not).
  const wantClosure = haveOids.length > 0 ? collectReachable(repo.objects, wantOids) : new Set<string>();
  const acks = haveOids.filter((oid) => wantClosure.has(oid));

  const send = new Map<string, GitObject>();

  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (send.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      send.set(oid, object);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue; // gitlink: a commit the repo does not hold
          stack.push(entry.oid);
        }
      }
    }
  };

  // Commit ancestry, breadth-first from the wants. Depth 1 is the want itself.
  const depthOf = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  let head = 0;
  const enqueueCommit = (oid: string, depth: number): void => {
    if (depthOf.has(oid)) return;
    depthOf.set(oid, depth);
    queue.push({ oid, depth });
  };

  for (const want of wantOids) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      send.set(want, object);
      const target = tagTargetOid(object.data);
      if (!target) continue;
      const targetObject = repo.objects.get(target);
      if (!targetObject) continue;
      if (targetObject.type === 'commit') enqueueCommit(target, 1);
      else if (targetObject.type === 'tree') addTreeClosure(target);
      else send.set(target, targetObject);
    } else if (object.type === 'commit') {
      enqueueCommit(want, 1);
    } else if (object.type === 'tree') {
      addTreeClosure(want);
    } else {
      send.set(want, object);
    }
  }

  while (head < queue.length) {
    const { oid, depth } = queue[head] as { oid: string; depth: number };
    head += 1;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    send.set(oid, object);
    const parsed = parseCommit(object.data);
    if (!parsed) continue;
    addTreeClosure(parsed.tree);
    if (depthLimit === null || depth < depthLimit) {
      for (const parent of parsed.parents) enqueueCommit(parent, depth + 1);
    }
  }

  for (const oid of excluded) send.delete(oid);

  const shallow: string[] = [];
  if (depthLimit !== null) {
    for (const [oid, depth] of depthOf) {
      if (depth === depthLimit && send.has(oid)) shallow.push(oid);
    }
    shallow.sort();
  }
  const unshallow: string[] = [];
  for (const boundary of shallowSet) {
    const depth = depthOf.get(boundary);
    if (depth !== undefined && (depthLimit === null || depth < depthLimit)) unshallow.push(boundary);
  }
  unshallow.sort();

  return { send, shallow, unshallow, acks };
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

const UPLOAD_V0_CAPS =
  'symref=HEAD:refs/heads/main side-band-64k side-band thin-pack ofs-delta shallow multi_ack no-progress ' +
  `agent=${AGENT}`;
const RECEIVE_V0_CAPS =
  'symref=HEAD:refs/heads/main report-status report-status-v2 delete-refs side-band-64k ofs-delta ' +
  `agent=${AGENT}`;

/** v0 ref advertisement, with the `# service=...` preamble and a flush after it. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headTip = headTipOid(repo);
    let capsAttached = false;
    if (headTip !== null) {
      lines.push(`${headTip} HEAD\0${caps}\n`);
      capsAttached = true;
    }
    for (const ref of refs) {
      if (!capsAttached) {
        lines.push(`${ref.oid} ${ref.name}\0${caps}\n`);
        capsAttached = true;
      } else {
        lines.push(`${ref.oid} ${ref.name}\n`);
      }
      const peeled = peelOid(repo, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 capability advertisement for git-upload-pack. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    // agent= / object-format= and anything else: accepted and ignored.
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = headTipOid(repo);
  if (keep('HEAD')) {
    if (headTip !== null) {
      parts.push(pktLine(`${headTip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.symrefs && ref.name === 'HEAD') line += ' symref-target:refs/heads/main';
    if (args.peel) {
      const peeled = peelOid(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack: v2 command request (ls-refs / fetch)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) args.depth = n;
    }
    // thin-pack / no-progress / ofs-delta / filter / deepen-since / deepen-not /
    // done / agent= / object-format= : accepted and ignored (filter is not
    // advertised; deepen-since / deepen-not are not used by this client).
  }
  return args;
}

function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  // With zero objects to send the packfile section is omitted entirely: an
  // empty packfile section is a protocol error to the client.
  if (plan.send.size > 0) {
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(buildPack(plan.send), 1)) parts.push(packet);
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack with Git-Protocol: version=2. */
function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const lines = reader.linesUntilFlush();
  // A v2 request may carry further packets after the first flush; the client
  // sends exactly one command block, so anything else is ignored here.
  if (lines.length === 0) throw bad('empty v2 upload-pack request');
  const command = (lines[0] as string).replace(/\n$/, '');
  if (command === 'command=ls-refs') {
    return lsRefsResponse(repo, parseLsRefsArgs(lines.slice(1)));
  }
  if (command === 'command=fetch') {
    return v2FetchResponse(repo, parseFetchArgs(lines.slice(1)));
  }
  throw bad(`unknown v2 upload-pack command ${JSON.stringify(command.slice(0, 40))}`);
}

// ---------------------------------------------------------------------------
// upload-pack: v0 request (want/have/done, two flush-separated sections)
// ---------------------------------------------------------------------------

/** POST /{owner}/{repo}.git/git-upload-pack without a version=2 header. */
function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    // flush / delim only separate the want and negotiation sections.
  }
  if (lines.length === 0) throw bad('empty v0 upload-pack request');
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string; // first want line carries capabilities
      args.wants.push(oid.trim());
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      args.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) args.depth = n;
    }
    // done / deepen-since / deepen-not: accepted and ignored.
  }
  if (args.wants.length === 0) throw bad('v0 upload-pack request has no want lines');
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.send.size > 0) {
    for (const packet of sidebandPackets(buildPack(plan.send), 1)) parts.push(packet);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack: v0 only
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack. Returns the report-status body. */
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  let first = true;
  for (;;) {
    const packet = reader.next();
    if (packet === null) throw bad('receive-pack request has no flush after its commands');
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') throw bad('unexpected packet in receive-pack commands');
    let line = packet.payload.toString('utf8');
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul); // client capabilities, ignored
      first = false;
    }
    line = line.replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) throw bad(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  if (commands.length === 0) throw bad('receive-pack request has no commands');

  // The pack follows the flush: always present when a command creates/updates
  // a ref (even empty, count 0), absent for delete-only command lists.
  const packBytes = reader.rest();
  if (packBytes.length > 0) {
    const objects = readPack(packBytes, repo); // throws BadRequest: nothing stored
    for (const [oid, object] of objects) repo.objects.set(oid, object);
  }

  // Apply the commands in order; a refused ref never moves, but the unpack
  // itself still succeeded, so the report always starts with "unpack ok".
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === null || command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== null) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    } else {
      // Update: old must match the tip and new must descend from old.
      if (current === null || command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      } else if (!isAncestor(repo.objects, command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    }
  }

  const reportLines = ['unpack ok\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const reportBytes = Buffer.concat(reportLines.map((line) => pktLine(line)));
  return Buffer.concat([...sidebandPackets(reportBytes, 1), pktFlush()]);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const GIT_ROUTE_RE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * Handle one HTTP request for the git smart-HTTP surface.
 *
 * Returns null when the path is not a git route (app.ts falls through to its
 * own routing). For a git route it always returns a response: unknown repos
 * are 404 regardless of auth, a known repo with a bad/absent token is 401,
 * a malformed git body is 400, and anything unexpected is 500. It never throws.
 */
export async function handleGitRequest(
  method: string,
  url: URL,
  headers: Headers,
  body: Buffer,
  store: Store,
  isAuthed: boolean,
): Promise<GitHandlerResult | null> {
  try {
    let pathname: string;
    let serviceParam: string | null = null;
    try {
      const parsed = url instanceof URL ? url : new URL(String(url), 'http://entry');
      pathname = parsed.pathname;
      serviceParam = parsed.searchParams.get('service');
    } catch {
      return null;
    }
    const match = GIT_ROUTE_RE.exec(pathname);
    if (!match) return null;
    const owner = match[1] as string;
    const repoName = match[2] as string;
    const route = match[3] as string;
    const verb = (method ?? '').toUpperCase();

    if (!NAME_RE.test(owner) || !NAME_RE.test(repoName) || repoName.endsWith('.git')) {
      return jsonResult(404, { message: 'Not Found' });
    }
    const isInfoRefs = route === 'info/refs';
    if ((isInfoRefs && verb !== 'GET') || (!isInfoRefs && verb !== 'POST')) {
      return jsonResult(404, { message: 'Not Found' });
    }

    const repo = store.getRepo(owner, repoName);
    if (repo === null) return jsonResult(404, { message: 'Not Found' });
    if (!isAuthed) return jsonResult(401, { message: 'Requires authentication' });

    const requestBody = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    const wantsV2 = (getHeader(headers, 'git-protocol') ?? '').toLowerCase().includes('version=2');

    if (isInfoRefs) {
      if (serviceParam === 'git-upload-pack') {
        return wantsV2
          ? gitResult(200, 'application/x-git-upload-pack-advertisement', v2Advertisement())
          : gitResult(200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
      }
      if (serviceParam === 'git-receive-pack') {
        // Receive-pack is v0-only: a v2 answer here fails the client outright.
        return gitResult(200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
      }
      return jsonResult(400, { message: 'Bad Request' });
    }

    if (route === 'git-upload-pack') {
      const responseBody = wantsV2
        ? handleUploadPackV2(repo, requestBody)
        : handleUploadPackV0(repo, requestBody);
      return gitResult(200, 'application/x-git-upload-pack-result', responseBody);
    }

    // git-receive-pack, v0 only.
    return gitResult(200, 'application/x-git-receive-pack-result', handleReceivePack(repo, requestBody));
  } catch (err) {
    if (err instanceof BadRequest) return jsonResult(400, { message: 'Bad Request' });
    return jsonResult(500, { message: 'Internal Server Error' });
  }
}
