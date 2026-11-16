// GraphQL v4: a small parser for the documents gh and github-mcp-server send, and an
// executor over the same store REST uses. Supports variables, aliases, inline fragments,
// input objects, enums, batched operation arrays, and __type introspection.

import {
  VIEWER,
  store,
  trialNowIso,
  globalId,
  parseGlobalId,
  peelToCommit,
  parseCommit,
  treeToMap,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { computeMergeable, mergePullRequest, pullFiles } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

interface Token {
  kind: 'name' | 'string' | 'int' | 'punct' | 'spread';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += input[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < input.length && /[0-9.]/.test(input[i] as string)) {
        value += input[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i] as string)) {
        value += input[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

export interface GqlField {
  alias: string | null;
  name: string;
  args: Map<string, GqlValue>;
  selections: GqlField[] | null;
  /** Inline fragment type condition (`... on Repository`). */
  fragmentOn: string | null;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlField[];
}

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (!token || token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }
  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token) break;
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const nameToken = this.peek();
        if (nameToken && nameToken.kind === 'name') {
          name = nameToken.value;
          this.next();
        }
        // Variable definitions: skip them (values come from the variables map).
        if (this.isPunct('(')) this.skipBalanced('(', ')');
        operations.push({ kind, name, selections: this.parseSelectionSet() });
      } else if (this.isPunct('{')) {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return operations;
  }
  skipBalanced(open: string, close: string): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const token = this.next() as Token;
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }
  parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!this.isPunct('}')) {
      const token = this.peek();
      if (!token) break;
      if (token.kind === 'spread') {
        this.next();
        let fragmentOn: string | null = null;
        const onToken = this.peek();
        if (onToken && onToken.kind === 'name' && onToken.value === 'on') {
          this.next();
          const typeToken = this.next();
          fragmentOn = typeToken?.value ?? null;
        } else {
          // Named fragment spread: skip the name; fragments are not used by the suite.
          this.next();
          continue;
        }
        const inner = this.parseSelectionSet();
        for (const field of inner) fields.push({ ...field, fragmentOn });
        continue;
      }
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }
  parseField(): GqlField {
    const first = this.next();
    if (!first || first.kind !== 'name') throw new Error('expected a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      const nameToken = this.next();
      if (!nameToken || nameToken.kind !== 'name') throw new Error('expected a field name after alias');
      name = nameToken.value;
    }
    const args = new Map<string, GqlValue>();
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.next();
        if (!argName || argName.kind !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args.set(argName.value, this.parseValue());
      }
      this.expectPunct(')');
    }
    let selections: GqlField[] | null = null;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { alias, name, args, selections, fragmentOn: null };
  }
  parseValue(): GqlValue {
    const token = this.next();
    if (!token) throw new Error('expected a value');
    if (token.kind === 'punct' && token.value === '$') {
      const nameToken = this.next();
      if (!nameToken || nameToken.kind !== 'name') throw new Error('expected a variable name');
      return { kind: 'variable', name: nameToken.value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, GqlValue>();
      while (!this.isPunct('}')) {
        const key = this.next();
        if (!key || key.kind !== 'name') throw new Error('expected an object key');
        this.expectPunct(':');
        fields.set(key.value, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected token ${token.value}`);
  }
}

export function parseDocument(query: string): GqlOperation[] {
  return new Parser(tokenize(query)).parseDocument();
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

function argOf(field: GqlField, name: string, variables: Record<string, unknown>): unknown {
  const value = field.args.get(name);
  if (value === undefined) return undefined;
  return resolveValue(value, variables);
}

// ---------------------------------------------------------------- schema (for __type)

const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'fork'],
  User: ['id', 'login', 'name', 'email'],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'MILESTONE'];

// ---------------------------------------------------------------- executor

interface ExecContext {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type GqlObject = { __typename: string; [key: string]: unknown };

function repoById(repoId: number): Repo | undefined {
  return store.order.find((r) => r.id === repoId);
}

function issueNode(repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullNode(repo: Repo, pull: Pull): GqlObject {
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: computeMergeable(repo, pull),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function repoNode(repo: Repo): GqlObject {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: globalId('Repository', repo.id, 0),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: trialNowIso(),
    updatedAt: trialNowIso(),
    url: `/${repo.owner}/${repo.name}`,
    isPrivate: repo.isPrivate,
    fork: false,
  };
}

function userNode(login: string): GqlObject {
  return { __typename: 'User', login, id: globalId('User', 0, VIEWER.id), name: VIEWER.name, email: VIEWER.email };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function resolveField(typeName: string, obj: GqlObject, field: GqlField, ctx: ExecContext): unknown {
  const repo = obj.__repo as Repo | undefined;
  // __typename is available on every object.
  if (field.name === '__typename') return typeName;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return userNode(VIEWER.login);
      if (field.name === 'repository') {
        const owner = argOf(field, 'owner', ctx.variables) as string;
        const name = argOf(field, 'name', ctx.variables) as string;
        const found = store.getRepo(owner, name);
        return found ? repoNode(found) : null;
      }
      if (field.name === 'node') {
        const id = argOf(field, 'id', ctx.variables) as string;
        const parsed = parseGlobalId(id ?? '');
        if (!parsed) return null;
        const foundRepo = repoById(parsed.repoId);
        if (!foundRepo) return null;
        if (parsed.kind === 'Repository') return repoNode(foundRepo);
        if (parsed.kind === 'Issue') {
          const issue = foundRepo.issues.find((i) => i.number === parsed.num);
          return issue ? issueNode(foundRepo, issue) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const pull = foundRepo.pulls.find((p) => p.number === parsed.num);
          return pull ? pullNode(foundRepo, pull) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = argOf(field, 'name', ctx.variables) as string;
        if (name === 'SearchType') {
          return { __typename: '__Type', name, kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES.map((v) => ({ name: v })) };
        }
        const fields = SCHEMA_FIELDS[name];
        if (!fields) return null;
        return { __typename: '__Type', name, kind: 'OBJECT', fields: fields.map((f) => ({ name: f })), enumValues: [] };
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
      return null;
    }
    case 'Repository': {
      if (!repo) return null;
      if (field.name === 'owner') return userNode(repo.owner);
      if (field.name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch };
      if (field.name === 'issue') {
        const number = argOf(field, 'number', ctx.variables) as number;
        const issue = repo.issues.find((i) => i.number === number);
        return issue ? issueNode(repo, issue) : null;
      }
      if (field.name === 'issues') {
        const first = argOf(field, 'first', ctx.variables) as number | undefined;
        const after = argOf(field, 'after', ctx.variables) as string | null | undefined;
        const states = argOf(field, 'states', ctx.variables) as string[] | undefined;
        const orderBy = argOf(field, 'orderBy', ctx.variables) as Record<string, unknown> | undefined;
        let list = [...repo.issues];
        if (states && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        if (orderBy && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
          list.sort((a, b) => b.seq - a.seq || b.number - a.number);
        } else {
          list.sort((a, b) => a.seq - b.seq);
        }
        if (after) {
          const afterNumber = cursorNumber(after);
          if (afterNumber !== null) list = list.filter((i) => i.number > afterNumber);
        }
        const total = list.length;
        const page = first !== undefined ? list.slice(0, first) : list;
        const hasNextPage = first !== undefined && list.length > first;
        const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null;
        return {
          __typename: 'IssueConnection',
          __nodes: page.map((i) => issueNode(repo, i)),
          totalCount: total,
          pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length > 0 ? cursorFor(page[0]?.number as number) : null },
        };
      }
      if (field.name === 'pullRequests') {
        const first = argOf(field, 'first', ctx.variables) as number | undefined;
        let list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
        if (first !== undefined) list = list.slice(0, first);
        return { __typename: 'PullRequestConnection', __nodes: list.map((p) => pullNode(repo, p)), totalCount: repo.pulls.length };
      }
      if (field.name === 'pullRequest') {
        const number = argOf(field, 'number', ctx.variables) as number;
        const pull = repo.pulls.find((p) => p.number === number);
        return pull ? pullNode(repo, pull) : null;
      }
      if (field.name in obj) return obj[field.name];
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
      return null;
    }
    case 'Issue': {
      if (field.name === 'author') return userNode(VIEWER.login);
      if (field.name === 'labels') {
        const issue = obj.__issue as Issue;
        return { __typename: 'LabelConnection', __nodes: issue.labels.map((name) => ({ __typename: 'Label', name })) };
      }
      if (field.name === 'comments') {
        const issue = obj.__issue as Issue;
        return {
          __typename: 'IssueCommentConnection',
          __nodes: issue.comments.map((c) => ({ __typename: 'IssueComment', id: globalId('Comment', repo?.id ?? 0, c.id), body: c.body })),
        };
      }
      if (field.name === 'repository') return repo ? repoNode(repo) : null;
      if (field.name in obj) return obj[field.name];
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Issue".` });
      return null;
    }
    case 'PullRequest': {
      if (!repo) return null;
      const pull = obj.__pull as Pull;
      if (field.name === 'files') {
        const first = argOf(field, 'first', ctx.variables) as number | undefined;
        let files = pullFiles(repo, pull).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename as string, additions: f.additions, deletions: f.deletions }));
        if (first !== undefined) files = files.slice(0, first);
        return { __typename: 'PullRequestChangedFileConnection', __nodes: files, totalCount: files.length };
      }
      if (field.name === 'author') return userNode(VIEWER.login);
      if (field.name === 'repository') return repoNode(repo);
      if (field.name in obj) return obj[field.name];
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".` });
      return null;
    }
    case 'User': {
      if (field.name in obj) return obj[field.name];
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "User".` });
      return null;
    }
    case '__Type': {
      if (field.name === 'fields') {
        const fields = (obj.fields as Array<{ name: string }>) ?? [];
        return fields;
      }
      if (field.name === 'enumValues') {
        return (obj.enumValues as Array<{ name: string }>) ?? [];
      }
      if (field.name in obj) return obj[field.name];
      return null;
    }
    default: {
      if (field.name in obj) return obj[field.name];
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
  }
}

function executeSelections(typeName: string, obj: GqlObject | null, selections: GqlField[], ctx: ExecContext): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.fragmentOn !== null && field.fragmentOn !== typeName) continue;
    const key = field.alias ?? field.name;
    const value = resolveField(typeName, obj, field, ctx);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (field.selections === null) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => executeSelections(item.__typename as string, item, field.selections as GqlField[], ctx));
      continue;
    }
    if (typeof value === 'object') {
      const typed = value as GqlObject;
      if (typed.__nodes !== undefined) {
        const connectionSelections = field.selections as GqlField[];
        const nodesField = connectionSelections.find((s) => s.name === 'nodes');
        const nodeObjects = typed.__nodes as GqlObject[];
        const nodes = nodesField
          ? nodeObjects.map((item) => executeSelections(item.__typename as string, item, nodesField.selections ?? [], ctx))
          : nodeObjects;
        const rest: Record<string, unknown> = {};
        for (const sub of connectionSelections) {
          if (sub.name === 'nodes') rest[sub.alias ?? 'nodes'] = nodes;
          else if (sub.name === 'pageInfo' && typed.pageInfo) rest[sub.alias ?? 'pageInfo'] = executeSelections('PageInfo', typed.pageInfo as GqlObject, sub.selections ?? [], ctx);
          else if (sub.name === 'totalCount') rest[sub.alias ?? 'totalCount'] = typed.totalCount ?? nodes.length;
          else if (sub.name === 'edges') {
            const nodeField = (sub.selections ?? []).find((s) => s.name === 'node');
            rest[sub.alias ?? 'edges'] = nodeObjects.map((item) => ({
              node: nodeField ? executeSelections(item.__typename as string, item, nodeField.selections ?? [], ctx) : null,
            }));
          }
        }
        out[key] = rest;
        continue;
      }
      const childType = (typed.__typename as string) ?? typeName;
      out[key] = executeSelections(childType, typed, field.selections, ctx);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function createIssueInRepo(repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    id: store.nextObjectId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [],
    seq: ++store.seq,
    comments: [],
    createdAt: trialNowIso(),
    updatedAt: trialNowIso(),
  };
  repo.issues.push(issue);
  return issue;
}

function executeMutation(op: GqlOperation, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of op.selections) {
    const key = field.alias ?? field.name;
    const input = argOf(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
    if (field.name === 'createIssue' && input) {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed ? repoById(parsed.repoId) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found.' });
        out[key] = null;
        continue;
      }
      const issue = createIssueInRepo(repo, String(input.title ?? ''), String(input.body ?? ''));
      out[key] = executeSelections('CreateIssuePayload', { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) }, field.selections ?? [], ctx);
      continue;
    }
    if (field.name === 'closeIssue' && input) {
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      const repo = parsed ? repoById(parsed.repoId) : undefined;
      const issue = repo?.issues.find((i) => i.number === parsed?.num);
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Issue not found.' });
        out[key] = null;
        continue;
      }
      issue.state = 'closed';
      issue.updatedAt = trialNowIso();
      out[key] = executeSelections('CloseIssuePayload', { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) }, field.selections ?? [], ctx);
      continue;
    }
    if (field.name === 'createPullRequest' && input) {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed ? repoById(parsed.repoId) : undefined;
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo?.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo?.refs.get(`refs/heads/${baseRef}`);
      if (!repo || !headSha || !baseSha) {
        ctx.errors.push({ message: 'Head or base branch does not exist.' });
        out[key] = null;
        continue;
      }
      const duplicate = repo.pulls.find((p) => p.headRef === headRef && p.baseRef === baseRef && p.state === 'open');
      if (duplicate) {
        ctx.errors.push({ message: 'A pull request already exists for this branch.' });
        out[key] = null;
        continue;
      }
      const pull: Pull = {
        id: store.nextObjectId++,
        number: repo.nextPull++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        merged: false,
        headRef,
        baseRef,
        headSha,
        baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        seq: ++store.seq,
        createdAt: trialNowIso(),
        updatedAt: trialNowIso(),
      };
      repo.pulls.push(pull);
      out[key] = executeSelections('CreatePullRequestPayload', { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) }, field.selections ?? [], ctx);
      continue;
    }
    if (field.name === 'mergePullRequest' && input) {
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      const repo = parsed ? repoById(parsed.repoId) : undefined;
      const pull = repo?.pulls.find((p) => p.number === parsed?.num);
      if (!repo || !pull) {
        ctx.errors.push({ message: 'Pull request not found.' });
        out[key] = null;
        continue;
      }
      const result = mergePullRequest(repo, pull);
      if (result.status !== 200) {
        ctx.errors.push({ message: 'Pull request cannot be merged.' });
        out[key] = null;
        continue;
      }
      out[key] = executeSelections('MergePullRequestPayload', { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) }, field.selections ?? [], ctx);
      continue;
    }
    if (field.name === 'addComment' && input) {
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      const repo = parsed ? repoById(parsed.repoId) : undefined;
      const issue = repo?.issues.find((i) => i.number === parsed?.num);
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Subject not found.' });
        out[key] = null;
        continue;
      }
      const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), user: VIEWER.login, createdAt: trialNowIso() };
      issue.comments.push(comment);
      issue.updatedAt = trialNowIso();
      const node: GqlObject = { __typename: 'IssueComment', id: globalId('Comment', repo.id, comment.id), body: comment.body };
      out[key] = executeSelections('AddCommentPayload', { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node } }, field.selections ?? [], ctx);
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
    out[key] = null;
  }
  return out;
}

export interface GqlResult {
  data: unknown;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(query: string, variables: Record<string, unknown>): GqlResult {
  let operations: GqlOperation[];
  try {
    operations = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  if (operations.length === 0) return { data: {}, errors: [{ message: 'No operations in document.' }] };
  const ctx: ExecContext = { variables, errors: [] };
  const op = operations[0] as GqlOperation;
  if (op.kind === 'mutation') {
    const data = executeMutation(op, ctx);
    return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
  }
  const data = executeSelections('Query', { __typename: 'Query' }, op.selections, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/** Handle one GraphQL HTTP body (single operation or a batched array). */
export function handleGraphQL(body: unknown): { status: number; body: unknown } {
  const runOne = (entry: unknown): GqlResult => {
    if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Request must be a JSON object.' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables !== null && typeof record.variables === 'object' ? record.variables : {}) as Record<string, unknown>;
    if (query === '') return { data: null, errors: [{ message: 'No query provided.' }] };
    return executeGraphQL(query, variables);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}
