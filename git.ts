// Git smart HTTP: pkt-line framing, packfile read/write (plain + delta), protocol v2
// upload-pack (ls-refs, fetch with shallow support), v0 upload-pack, and v0 receive-pack
// with per-ref fast-forward enforcement and report-status over side-band-64k.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  putObject,
  store,
  VIEWER,
  fetchObjects,
  isAncestor,
  type GitObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a buffer into pkt-line payloads; returns null on malformed framing. */
export function decodePktLines(buf: Buffer): { payloads: Buffer[]; rest: Buffer } | null {
  const payloads: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      payloads.push(Buffer.alloc(0));
      offset += 4;
      continue;
    }
    if (length === 1 || length === 2) {
      payloads.push(Buffer.alloc(0));
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) return null;
    payloads.push(buf.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { payloads, rest: Buffer.alloc(0) };
}

// ---------------------------------------------------------------- packfile write

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

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

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- packfile read (with delta resolution)

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
}

/** Parse a packfile (v2), resolving OFS/REF deltas against the pack and `baseLookup`. */
export function readPack(pack: Buffer, baseLookup?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = baseLookup?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} missing`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects };
}

// ---------------------------------------------------------------- ref listing

export interface RefInfo {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repo, sorted by name, with peeled targets for annotated tags. */
export function listRefs(repo: Repo): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const info: RefInfo = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) info.peeled = peeled;
    }
    refs.push(info);
  }
  return refs;
}

export function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Sideband-wrap a pack into pkt-lines (band 1), chunked under the pkt-line maximum. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- info/refs

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
}

function findGitRepo(owner: string, repoName: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, repoName) ?? null;
}

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow multi_ack agent=github-core-forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=github-core-forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';

export function handleInfoRefs(owner: string, repoName: string, service: string, wantsV2: boolean): GitResponse {
  const repo = findGitRepo(owner, repoName);
  if (!repo) return notFound();
  const refs = listRefs(repo);
  const headRef = headTarget(repo);
  const headOid = repo.refs.get(headRef) ?? ZERO_OID;
  if (service === 'git-upload-pack' && wantsV2) {
    const body = pktLines([
      'version 2\n',
      'agent=github-core-forge/1.0\n',
      'ls-refs\n',
      'fetch=shallow wait-for-done filter\n',
      'object-format=sha1\n',
      'flush',
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  if (service === 'git-upload-pack') {
    const caps = UPLOAD_CAPS_V0;
    const lines: (string | 'flush')[] = [`# service=git-upload-pack\n`, 'flush'];
    if (refs.length === 0) {
      lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    } else {
      lines.push(`${headOid} HEAD\0${caps}\n`);
      for (const ref of refs) {
        lines.push(`${ref.oid} ${ref.name}\n`);
        if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
      }
    }
    lines.push('flush');
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: pktLines(lines) };
  }
  // git-receive-pack: always v0.
  const lines: (string | 'flush')[] = [`# service=git-receive-pack\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`);
  } else {
    lines.push(`${headOid} HEAD\0${RECEIVE_CAPS}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: pktLines(lines) };
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  const decoded = decodePktLines(body);
  if (!decoded) return null;
  const lines: string[] = [];
  for (const payload of decoded.payloads) {
    if (payload.length === 0) continue;
    lines.push(payload.toString('utf8'));
  }
  if (lines.length === 0) return null;
  const first = lines[0] as string;
  if (!first.startsWith('command=')) return null;
  return { command: first.slice('command='.length).replace(/\n$/, ''), args: lines.slice(1) };
}

function buildFetchPack(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const cacheKey = `${repo.version}|${[...args.wants].sort().join(',')}|${[...args.haves].sort().join(',')}|${args.depth ?? ''}|${[...args.shallow].sort().join(',')}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached) {
    // The shallow/unshallow lists are deterministic for the same inputs; recompute cheaply.
    const held = new Set(args.haves);
    const computed = fetchObjects(repo, args.wants, held, args.depth, args.shallow);
    return { pack: cached, shallow: computed.shallow, unshallow: computed.unshallow };
  }
  const held = new Set(args.haves);
  const computed = fetchObjects(repo, args.wants, held, args.depth, args.shallow);
  const objects: GitObject[] = [];
  for (const oid of computed.objects) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  // Deterministic pack order: sort by oid so identical requests give identical bytes.
  objects.sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const pack = writePack(objects);
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(cacheKey, pack);
  return { pack, shallow: computed.shallow, unshallow: computed.unshallow };
}

function handleLsRefs(repo: Repo, args: string[]): GitResponse {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = listRefs(repo);
  const headRef = headTarget(repo);
  const headOid = repo.refs.get(headRef) ?? ZERO_OID;
  const lines: string[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length > 0 && keep('HEAD')) {
    lines.push(symrefs ? `${headOid} HEAD symref-target:${headRef}\n` : `${headOid} HEAD\n`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: pktLines([...lines, 'flush']) };
}

function handleFetchV2(repo: Repo, args: string[]): GitResponse {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) parsed.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) parsed.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) parsed.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) parsed.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') parsed.done = true;
  }
  const { pack, shallow, unshallow } = buildFetchPack(repo, parsed);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(FLUSH);
  if (parsed.depth !== null || parsed.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleFetchV0(repo: Repo, body: Buffer): GitResponse {
  const decoded = decodePktLines(body);
  if (!decoded) return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed pkt-line\n', 'utf8') };
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const payload of decoded.payloads) {
    const line = payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) parsed.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) parsed.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) parsed.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) parsed.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') parsed.done = true;
  }
  const { pack, shallow, unshallow } = buildFetchPack(repo, parsed);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function handleUploadPack(owner: string, repoName: string, body: Buffer, wantsV2: boolean): GitResponse {
  const repo = findGitRepo(owner, repoName);
  if (!repo) return notFound();
  if (wantsV2) {
    const parsed = parseV2Command(body);
    if (!parsed) return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed request\n', 'utf8') };
    if (parsed.command === 'ls-refs') return handleLsRefs(repo, parsed.args);
    if (parsed.command === 'fetch') return handleFetchV2(repo, parsed.args);
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown command ${parsed.command}\n`, 'utf8') };
  }
  return handleFetchV0(repo, body);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = findGitRepo(owner, repoName);
  if (!repo) return notFound();
  // The body is pkt-line commands up to a flush, then the pack as raw bytes, so it
  // cannot be decoded as pure pkt-lines. Parse the command section by hand.
  const commands: PushCommand[] = [];
  let packStart = body.length;
  {
    let pos = 0;
    while (pos < body.length) {
      if (pos + 4 > body.length) break;
      const head = body.subarray(pos, pos + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
      const length = Number.parseInt(head, 16);
      if (length === 0) {
        packStart = pos + 4;
        break;
      }
      if (length < 4 || pos + length > body.length) break;
      const payload = body.subarray(pos + 4, pos + length).toString('utf8');
      const nul = payload.indexOf('\0');
      const text = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const parts = text.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
      }
      pos += length;
    }
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed pkt-line\n', 'utf8') };
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (commands.some((c) => c.newOid !== ZERO_OID)) {
    const packBytes = body.subarray(packStart);
    if (packBytes.length > 0) {
      try {
        const read = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack error';
      }
    }
  }
  const reportLines: string[] = [];
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = true;
      let reason = '';
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (!current) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        }
        if (ok) repo.refs.delete(command.ref);
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!repo.objects.has(command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
        if (ok) repo.refs.set(command.ref, command.newOid);
      } else {
        // Update.
        if (!current || command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!repo.objects.has(command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
        if (ok) repo.refs.set(command.ref, command.newOid);
      }
      if (ok) {
        repo.version += 1;
        repo.packCache.clear();
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} ${reason}\n`);
      }
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack error\n`);
  }
  const reportBody = pktLines(reportLines);
  const framed = Buffer.concat([sidebandPack(reportBody), FLUSH]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: framed };
}

/** A raw POST to a git service that is not a valid request: answer 400, never crash. */
export function handleGitRaw(owner: string, repoName: string): GitResponse {
  const repo = findGitRepo(owner, repoName);
  if (!repo) return notFound();
  return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed request\n', 'utf8') };
}
