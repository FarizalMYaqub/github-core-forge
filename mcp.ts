// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP (POST /mcp), modern revision
// 2026-07-28 plus the legacy 2025-11-25 initialize handshake. Tools act on the
// same in-memory store as REST, so REST and MCP see identical state.

import { VIEWER, store, trialNowIso, type Repo, type Issue, type Pull } from './store.ts';
import { mergePullRequest, pullFiles } from './rest.ts';

export const MCP_SERVER_NAME = 'github-core-forge';
export const MCP_SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and repo name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        merge_method: { type: 'string', description: 'Merge method: merge, squash, or rebase' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories for the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function pick(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    default_branch: repo.defaultBranch,
    private: repo.isPrivate,
    html_url: `/${repo.owner}/${repo.name}`,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login },
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merge_commit_sha: pull.mergeCommitSha,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function findRepo(args: Record<string, unknown>): Repo | undefined {
  const owner = String(pick(args, ['owner', 'owner_login', 'org', 'user', 'login']) ?? VIEWER.login);
  const repoName = String(pick(args, ['repo', 'repository', 'repo_name']) ?? '');
  const fullName = pick(args, ['full_name']) as string | undefined;
  if (fullName) {
    const [o, r] = fullName.split('/');
    if (o && r) return store.getRepo(o, r);
  }
  return store.getRepo(owner, repoName);
}

function toolError(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function toolOk(value: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function callTool(name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean } {
  switch (name) {
    case 'create_repo': {
      const repoName = pick(args, ['name', 'repo', 'repository']) as string | undefined;
      if (!repoName) return toolError('Missing required argument: name');
      if (store.getRepo(VIEWER.login, repoName)) return toolError('Repository already exists');
      const repo = store.createRepo(
        VIEWER.login,
        repoName,
        Boolean(pick(args, ['private']) ?? false),
        (pick(args, ['description']) as string) ?? '',
      );
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(args);
      if (!repo) return toolError('Repository not found');
      return toolOk(repoJson(repo));
    }
    case 'list_repos': {
      return toolOk(store.order.filter((r) => r.owner === VIEWER.login).map(repoJson));
    }
    case 'create_issue': {
      const repo = findRepo(args);
      if (!repo) return toolError('Repository not found');
      const title = pick(args, ['title', 'issue_title']) as string | undefined;
      if (!title) return toolError('Missing required argument: title');
      const body = (pick(args, ['body', 'description', 'content']) as string) ?? '';
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
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(args);
      if (!repo) return toolError('Repository not found');
      const state = (pick(args, ['state']) as string) ?? 'open';
      const list = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => issueJson(repo, i));
      return toolOk(list);
    }
    case 'get_issue': {
      const repo = findRepo(args);
      if (!repo) return toolError('Repository not found');
      const number = Number(pick(args, ['issue_number', 'number', 'issue']) ?? NaN);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return toolError('Issue not found');
      return toolOk(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = findRepo(args);
      if (!repo) return toolError('Repository not found');
      const title = pick(args, ['title', 'pr_title']) as string | undefined;
      const head = pick(args, ['head', 'head_ref', 'head_branch', 'source', 'from', 'branch']) as string | undefined;
      const base = pick(args, ['base', 'base_ref', 'base_branch', 'target', 'into']) as string | undefined;
      if (!title) return toolError('Missing required argument: title');
      if (!head) return toolError('Missing required argument: head');
      if (!base) return toolError('Missing required argument: base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('Head or base branch does not exist');
      const duplicate = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
      if (duplicate) return toolError('A pull request already exists for this branch');
      const body = (pick(args, ['body', 'description', 'content']) as string) ?? '';
      const pull: Pull = {
        id: store.nextObjectId++,
        number: repo.nextPull++,
        title,
        body,
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        seq: ++store.seq,
        createdAt: trialNowIso(),
        updatedAt: trialNowIso(),
      };
      repo.pulls.push(pull);
      return toolOk(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(args);
      if (!repo) return toolError('Repository not found');
      const number = Number(pick(args, ['pull_number', 'pr_number', 'number', 'pull_request_number']) ?? NaN);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolError('Pull request not found');
      const result = mergePullRequest(repo, pull);
      if (result.status === 405) return toolError('Pull request has conflicts and cannot be merged');
      if (result.status === 404) return toolError('Pull request not found');
      return toolOk({ sha: (result.body as Record<string, unknown>).sha, merged: true, message: (result.body as Record<string, unknown>).message });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export interface McpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const SESSION_ID = 'forge-session-1';

export function handleMcp(rawBody: string, headers: Record<string, string | undefined>): McpResponse {
  const auth = headers['authorization'] ?? headers['Authorization'];
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!auth || !auth.startsWith('Bearer ')) {
    return { status: 401, body: { error: 'Unauthorized', message: 'Authentication required' } };
  }
  if (expected && auth.slice('Bearer '.length) !== expected) {
    return { status: 401, body: { error: 'Unauthorized', message: 'Invalid token' } };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } },
    };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = payload as Record<string, unknown>;
  const method = String(request.method ?? '');
  const id = request.id ?? null;

  // Notifications have no id: acknowledge with 202 and no result.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  const rpcResult = (result: unknown): McpResponse => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result },
    headers: { 'Mcp-Session-Id': SESSION_ID },
  });
  const rpcError = (code: number, message: string, status = 200): McpResponse => ({
    status,
    body: { jsonrpc: '2.0', id, error: { code, message } },
    headers: { 'Mcp-Session-Id': SESSION_ID },
  });

  if (method === 'server/discover') {
    const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
    return rpcResult({
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05'],
      serverInfo,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo, serverInfo },
    });
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    return rpcResult({
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'ping') return rpcResult({});
  if (method === 'tools/list') {
    return rpcResult({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const rawName = String(params.name ?? '');
    const tool = TOOLS.find(
      (t) => t.name === rawName || rawName.toLowerCase().endsWith(`__${t.name}`) || rawName.toLowerCase() === t.name,
    );
    if (!tool) return rpcError(-32601, `Method not found: ${rawName}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return rpcError(-32602, `Missing required argument(s): ${missing.join(', ')}`);
    }
    const result = callTool(tool.name, args);
    return rpcResult(result);
  }
  return rpcError(-32601, `Method not found: ${method}`);
}
