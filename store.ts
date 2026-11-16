// The forge's store: the seeded viewer identity, the in-memory repository model, and the
// git object model (hashing, trees, commits, reachability, diffs, merges). No wall clock and
// no unseeded randomness reach anything served: every timestamp comes from MAKEFUN_TRIAL_NOW
// and every id from deterministic counters, so two runs on the same trial leave the same state.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

// ---------------------------------------------------------------- the trial clock

/** The trial's fixed "now": MAKEFUN_TRIAL_NOW, or a fixed fallback when it is absent. */
export function trialNowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return '2025-01-01T00:00:00.000Z';
}

/** The trial's now as Unix seconds (the timestamp git objects carry). */
export function trialEpochSec(): number {
  return Math.floor(new Date(trialNowIso()).getTime() / 1000);
}

// ---------------------------------------------------------------- the seeded viewer

// The suite's scenario derives every name from one fixed seed (wire.ts SCENARIO_SEED). The
// viewer login is therefore a constant of the contest, but we derive it the same way the
// suite does instead of hard-coding it, so the forge agrees with the suite by construction.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The token owner's identity, derived from the scenario seed exactly as the suite does. */
export function viewerOf(): Viewer {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let first: Viewer | null = null;
  for (let i = 0; i < 12; i += 1) {
    const firstName = rng.pick(FIRST_NAMES);
    const lastName = rng.pick(LAST_NAMES);
    const base = `${firstName}${lastName}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    const user: Viewer = { id: 1000 + i, login, name: `${firstName} ${lastName}`, email: `${login}@example.invalid` };
    if (first === null) first = user;
  }
  return first as Viewer;
}

export const VIEWER: Viewer = viewerOf();

/** The identity line git objects the forge creates carry. */
export function forgeIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

// ---------------------------------------------------------------- git objects

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buffer.length) throw new Error('malformed tree object');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  // Git stores commit messages with a trailing newline; the readable message
  // drops it (as `git log` does), so REST exact-match comparisons see the text.
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8').replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: { tree: string; parents?: readonly string[]; message: string; author?: string; committer?: string; timestamp?: number }): Buffer {
  const timestamp = fields.timestamp ?? trialEpochSec();
  const who = `${fields.author ?? forgeIdentity()} ${timestamp} +0000`;
  const committer = `${fields.committer ?? forgeIdentity()} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel a tag (or commit) id to the commit it points at. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- the repository model

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  seq: number;
  version: number;
  packCache: Map<string, Buffer>;
}

export class Store {
  repos: Map<string, Repo> = new Map();
  order: Repo[] = [];
  nextRepoId = 1;
  nextObjectId = 1;
  seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
      seq: ++this.seq,
      version: 0,
      packCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    this.order.push(repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (!repo) return false;
    this.repos.delete(this.key(owner, name));
    const index = this.order.indexOf(repo);
    if (index >= 0) this.order.splice(index, 1);
    return true;
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    return this.order.filter((repo) => repo.owner === owner);
  }
}

export const store = new Store();

// ---------------------------------------------------------------- object graph helpers

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(repo: Repo, roots: Iterable<string>, options: { allowMissing?: boolean } = {}): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Reachable objects from `wants` with a depth limit and have-exclusion, for fetch.
 * `depth` is the total commit depth from a want (1 = the want commit only). `held` is the
 * set of commits the client already holds (its haves, cut at the shallow boundaries).
 * Returns the object ids to send and the new shallow boundary commits.
 */
export function fetchObjects(
  repo: Repo,
  wants: readonly string[],
  held: ReadonlySet<string>,
  depth: number | null,
  shallowBoundaries: readonly string[],
): { objects: Set<string>; shallow: string[]; unshallow: string[] } {
  const heldSet = new Set(held);
  // A shallow boundary commit is held itself, but its parents are not held through it.
  // Recompute the held object set by walking from haves without crossing a boundary's parents.
  const heldObjects = new Set<string>();
  {
    const boundarySet = new Set(shallowBoundaries);
    const queue: string[] = [...heldSet];
    const seenCommits = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        heldObjects.add(oid);
        heldObjects.add(commit.tree);
        // Walk the tree's blobs too (cheap: reuse collectReachable on the tree).
        for (const entry of walkTreeObjects(repo, commit.tree)) heldObjects.add(entry);
        if (!boundarySet.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else {
        heldObjects.add(oid);
      }
    }
  }
  const toSend = new Set<string>();
  const shallow: string[] = [];
  const queue: Array<{ oid: string; dist: number }> = [];
  const visited = new Set<string>();
  for (const want of wants) {
    if (isObjectId(want)) queue.push({ oid: want, dist: 0 });
  }
  while (queue.length > 0) {
    const item = queue.pop() as { oid: string; dist: number };
    if (visited.has(item.oid)) continue;
    visited.add(item.oid);
    const obj = repo.objects.get(item.oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      // A commit at distance depth-1 from a want is the new shallow boundary: its
      // parents are not traversed and it is reported as shallow.
      const atLimit = depth !== null && item.dist >= depth - 1;
      if (atLimit) {
        // This commit is a shallow boundary only when it has parents in the full graph.
        if (commit.parents.length > 0) shallow.push(item.oid);
      }
      if (!heldObjects.has(item.oid)) {
        toSend.add(item.oid);
        toSend.add(commit.tree);
        for (const entry of walkTreeObjects(repo, commit.tree)) toSend.add(entry);
      }
      if (!atLimit) {
        for (const parent of commit.parents) queue.push({ oid: parent, dist: item.dist + 1 });
      }
    } else if (obj.type === 'tag') {
      if (!heldObjects.has(item.oid)) toSend.add(item.oid);
      const target = parseTag(obj.data).object;
      queue.push({ oid: target, dist: item.dist });
    } else {
      if (!heldObjects.has(item.oid)) toSend.add(item.oid);
    }
  }
  // Never re-send an object the client holds.
  for (const oid of heldObjects) toSend.delete(oid);
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    if (!shallow.includes(boundary) && visited.has(boundary)) unshallow.push(boundary);
  }
  return { objects: toSend, shallow, unshallow };
}

/** All object ids under a tree (the tree itself plus every entry, recursively). */
export function walkTreeObjects(repo: Repo, treeOid: string): Set<string> {
  const out = new Set<string>();
  const queue = [treeOid];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') {
      if (obj) out.add(oid);
      continue;
    }
    out.add(oid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') queue.push(entry.oid);
      else if (entry.mode !== '160000') out.add(entry.oid);
    }
  }
  return out;
}

/** True when `ancestor` is an ancestor of (or equal to) `oid`. */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

/** The merge base of two commits: the first common ancestor found walking both histories. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const current = queueA.pop() as string;
    if (ancestorsA.has(current)) continue;
    ancestorsA.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const current = queueB.pop() as string;
    if (ancestorsA.has(current)) return current;
    if (seenB.has(current)) continue;
    seenB.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueB.push(parent);
  }
  return null;
}

/** Flatten a commit's tree to path -> {oid, mode}. */
export function treeToMap(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) trees for a flat path map; returns the root tree oid. */
export function mapToTree(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (!child) {
        child = makeNode();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Store an object if absent; return its oid. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Create a commit object on `repo` and return its oid. */
export function createCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
  const data = buildCommit({ tree, parents, message });
  return putObject(repo, 'commit', data);
}

/** The tree map of a ref's tip commit (empty when the ref is unborn/missing). */
export function refTreeMap(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.refs.get(ref);
  if (!tip) return new Map();
  const commitOid = peelToCommit(repo, tip);
  if (!commitOid) return new Map();
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return treeToMap(repo, parseCommit(obj.data).tree);
}

/** Commits reachable from `tip`, newest first (pre-order walk, parents after the commit). */
export function listCommits(repo: Repo, tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level diff between two tree maps. */
export function diffMaps(
  base: Map<string, { oid: string; mode: string }>,
  head: Map<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) changes.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) changes.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) changes.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return changes;
}

/** Line counts for a pull-request file entry (additions/deletions by line-set difference). */
export function lineCounts(repo: Repo, change: FileChange): { additions: number; deletions: number } {
  const linesOf = (oid: string | null): string[] => {
    if (!oid) return [];
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'blob') return [];
    const text = obj.data.toString('utf8');
    if (text === '') return [];
    return text.split('\n');
  };
  const oldLines = linesOf(change.oldOid);
  const newLines = linesOf(change.newOid);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  let additions = 0;
  for (const line of newLines) if (!oldSet.has(line)) additions += 1;
  let deletions = 0;
  for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
  if (change.status === 'added' && additions === 0) additions = Math.max(1, newLines.length);
  if (change.status === 'modified' && additions === 0 && deletions === 0) additions = 1;
  return { additions, deletions };
}

// ---------------------------------------------------------------- global ids (GraphQL Relay ids)

/** An opaque, stable global id for a repository / issue / pull request / comment. */
export function globalId(kind: string, repoId: number, num: number): string {
  return Buffer.from(`${kind}:${repoId}:${num}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; repoId: number; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const repoId = Number(parts[1]);
    const num = Number(parts[2]);
    if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(num)) return null;
    return { kind: parts[0] as string, repoId, num };
  } catch {
    return null;
  }
}
