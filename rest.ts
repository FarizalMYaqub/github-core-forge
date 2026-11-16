// The REST v3 surface: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, over the in-memory store. Every reply is JSON with a
// non-empty X-GitHub-Request-Id (added by app.ts); errors carry a string message.

import {
  VIEWER,
  store,
  trialNowIso,
  trialEpochSec,
  hashObject,
  putObject,
  createCommit,
  refTreeMap,
  treeToMap,
  mapToTree,
  listCommits,
  diffMaps,
  lineCounts,
  parseCommit,
  peelToCommit,
  mergeBase,
  globalId,
  isObjectId,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  /** A relative Link rel="next" target, absolutized by app.ts. */
  link?: string;
}

function ok(status: number, body: unknown, link?: string): RestResult {
  return { status, body, link };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id, 0),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User', avatar_url: '', html_url: '' },
    private: repo.isPrivate,
    html_url: `/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    pushed_at: trialNowIso(),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: 0, name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    pull_request: undefined,
  };
}

function pullHeadSha(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = pullHeadSha(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    mergeable: computeMergeable(repo, pull) === 'MERGEABLE',
    mergeable_state: computeMergeable(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: { login: repo.owner, id: VIEWER.id },
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login: repo.owner, id: VIEWER.id },
      repo: repoJson(repo),
    },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** MERGEABLE / CONFLICTING for a pull request, by three-way file comparison. */
export function computeMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  const headTip = peelToCommit(repo, pullHeadSha(repo, pull));
  const baseTip = peelToCommit(repo, repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha);
  if (!headTip || !baseTip) return 'MERGEABLE';
  if (headTip === baseTip) return 'MERGEABLE';
  const mb = mergeBase(repo, headTip, baseTip);
  if (!mb) return 'MERGEABLE';
  const mbObj = repo.objects.get(mb);
  const headObj = repo.objects.get(headTip);
  const baseObj = repo.objects.get(baseTip);
  if (!mbObj || !headObj || !baseObj) return 'MERGEABLE';
  const mbMap = treeToMap(repo, parseCommit(mbObj.data).tree);
  const headMap = treeToMap(repo, parseCommit(headObj.data).tree);
  const baseMap = treeToMap(repo, parseCommit(baseObj.data).tree);
  for (const [path, headEntry] of headMap) {
    const mbEntry = mbMap.get(path);
    const baseEntry = baseMap.get(path);
    const headChanged = !mbEntry || mbEntry.oid !== headEntry.oid;
    const baseChanged = baseEntry ? (!mbEntry || mbEntry.oid !== baseEntry.oid) : mbEntry !== undefined;
    if (headChanged && baseChanged) {
      const baseOid = baseEntry?.oid ?? null;
      if (baseOid !== headEntry.oid) return 'CONFLICTING';
    }
  }
  for (const [path, mbEntry] of mbMap) {
    if (!headMap.has(path) && baseMap.has(path)) {
      const baseEntry = baseMap.get(path) as { oid: string };
      if (baseEntry.oid !== mbEntry.oid) return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

/** The files a pull request changes (base snapshot vs current head tip). */
export function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const baseCommit = peelToCommit(repo, pull.baseSha);
  const headCommit = peelToCommit(repo, pullHeadSha(repo, pull));
  if (!baseCommit || !headCommit) return [];
  const baseObj = repo.objects.get(baseCommit);
  const headObj = repo.objects.get(headCommit);
  if (!baseObj || !headObj) return [];
  const baseMap = treeToMap(repo, parseCommit(baseObj.data).tree);
  const headMap = treeToMap(repo, parseCommit(headObj.data).tree);
  const out: Array<Record<string, unknown>> = [];
  for (const change of diffMaps(baseMap, headMap)) {
    const counts = lineCounts(repo, change);
    out.push({
      sha: change.newOid ?? change.oldOid ?? '',
      filename: change.path,
      status: change.status === 'modified' ? 'modified' : change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    });
  }
  return out;
}

/** Merge a pull request with a squash commit on the base branch. */
export function mergePullRequest(repo: Repo, pull: Pull): RestResult {
  if (pull.merged || pull.state === 'closed') return err(405, 'Pull request already merged');
  if (computeMergeable(repo, pull) === 'CONFLICTING') return err(405, 'Merge conflict');
  const headTip = peelToCommit(repo, pullHeadSha(repo, pull));
  const baseTip = peelToCommit(repo, repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha);
  if (!headTip || !baseTip) return err(405, 'Merge conflict');
  const mb = mergeBase(repo, headTip, baseTip);
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(headTip);
  if (!baseObj || !headObj) return err(405, 'Merge conflict');
  const baseMap = treeToMap(repo, parseCommit(baseObj.data).tree);
  const headMap = treeToMap(repo, parseCommit(headObj.data).tree);
  let mergedMap = new Map(baseMap);
  if (mb) {
    const mbObj = repo.objects.get(mb);
    if (mbObj) {
      const mbMap = treeToMap(repo, parseCommit(mbObj.data).tree);
      for (const change of diffMaps(mbMap, headMap)) {
        if (change.status === 'removed') mergedMap.delete(change.path);
        else mergedMap.set(change.path, { oid: change.newOid as string, mode: '100644' });
      }
    }
  } else {
    mergedMap = new Map(headMap);
  }
  const treeOid = mapToTree(repo, mergedMap);
  const message = `${pull.title} (#${pull.number})\n`;
  const squash = createCommit(repo, treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, squash);
  repo.version += 1;
  repo.packCache.clear();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = squash;
  pull.mergedAt = trialNowIso();
  pull.updatedAt = trialNowIso();
  return ok(200, { sha: squash, merged: true, message: 'Pull request successfully merged' });
}

// ---------------------------------------------------------------- contents helpers

function base64Of(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function contentEntry(repo: Repo, path: string, blobOid: string, ref: string): Record<string, unknown> {
  const obj = repo.objects.get(blobOid);
  const size = obj ? obj.data.length : 0;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    content: obj ? obj.data.toString('base64') : '',
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: '',
    html_url: `/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
    download_url: '',
    _links: { self: '', git: '', html: '' },
  };
}

/** Commit a new tree map on `branch` (creating the branch from the default tip if needed). */
export function commitTreeMap(repo: Repo, branch: string, flat: Map<string, { oid: string; mode: string }>, message: string): string {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (!tip) {
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip) {
      tip = defaultTip;
      repo.refs.set(ref, tip);
    }
  }
  const treeOid = mapToTree(repo, flat);
  const parents = tip ? [peelToCommit(repo, tip) as string] : [];
  const commitOid = createCommit(repo, treeOid, parents.filter(Boolean), message.endsWith('\n') ? message : `${message}\n`);
  repo.refs.set(ref, commitOid);
  repo.version += 1;
  repo.packCache.clear();
  return commitOid;
}

function putContents(repo: Repo, path: string, body: Record<string, unknown>): RestResult {
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  const content = typeof body.content === 'string' ? body.content : '';
  let bytes: Buffer;
  try {
    bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
  } catch {
    return err(400, 'content is not valid base64');
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const flat = refTreeMap(repo, `refs/heads/${branch}`);
  const existing = flat.get(path);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (sha !== undefined && existing && sha.toLowerCase() !== existing.oid.toLowerCase()) {
    return err(409, 'sha does not match the current file');
  }
  const isCreate = !existing;
  const blobOid = putObject(repo, 'blob', bytes);
  flat.set(path, { oid: blobOid, mode: '100644' });
  const commitOid = commitTreeMap(repo, branch, flat, message);
  return ok(isCreate ? 201 : 200, {
    content: contentEntry(repo, path, blobOid, branch),
    commit: { sha: commitOid, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
  });
}

function getContents(repo: Repo, path: string, ref: string | undefined): RestResult {
  const branch = ref ?? repo.defaultBranch;
  let tip: string | undefined;
  if (branch.startsWith('refs/')) tip = repo.refs.get(branch);
  else tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip && ref && isObjectId(ref) && repo.objects.has(ref)) tip = ref;
  if (!tip) return err(404, 'Not Found');
  const commitOid = peelToCommit(repo, tip);
  if (!commitOid) return err(404, 'Not Found');
  const commitObj = repo.objects.get(commitOid);
  if (!commitObj) return err(404, 'Not Found');
  const flat = treeToMap(repo, parseCommit(commitObj.data).tree);
  if (path === '') {
    // Root listing.
    const entries = new Map<string, { type: string; oid: string; path: string }>();
    for (const [p, entry] of flat) {
      const first = p.split('/')[0] as string;
      if (!entries.has(first)) {
        const isDir = p.includes('/');
        entries.set(first, { type: isDir ? 'dir' : 'file', oid: entry.oid, path: first });
      }
    }
    return ok(200, [...entries.values()].map((e) => ({
      type: e.type, name: e.path.split('/').pop(), path: e.path, sha: e.oid, size: 0,
      url: '', git_url: '', html_url: '', download_url: null, _links: {},
    })));
  }
  const direct = flat.get(path);
  if (direct) return ok(200, contentEntry(repo, path, direct.oid, branch));
  // Directory listing.
  const prefix = `${path}/`;
  const children = new Map<string, { type: string; oid: string }>();
  for (const [p, entry] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0] as string;
    if (!children.has(first)) {
      children.set(first, { type: rest.includes('/') ? 'dir' : 'file', oid: entry.oid });
    }
  }
  if (children.size === 0) return err(404, 'Not Found');
  return ok(200, [...children.entries()].map(([name, child]) => ({
    type: child.type, name, path: `${path}/${name}`, sha: child.oid, size: 0,
    url: '', git_url: '', html_url: '', download_url: null, _links: {},
  })));
}

function deleteContents(repo: Repo, path: string, body: Record<string, unknown> | null): RestResult {
  const message = body && typeof body.message === 'string' ? body.message : `Delete ${path}`;
  const branch = body && typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const flat = refTreeMap(repo, `refs/heads/${branch}`);
  if (!flat.has(path)) return err(404, 'Not Found');
  flat.delete(path);
  const commitOid = commitTreeMap(repo, branch, flat, message);
  return ok(200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------- pagination

function parsePage(query: Record<string, string>): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.per_page ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: Record<string, string>, basePath: string): { page: T[]; link?: string } {
  const { page, perPage } = parsePage(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | undefined;
  if (start + perPage < items.length) {
    const params = new URLSearchParams({ ...query, page: String(page + 1), per_page: String(perPage) });
    link = `${basePath}?${params.toString()}`;
  }
  return { page: slice, link };
}

// ---------------------------------------------------------------- the router

/** Handle one REST request. `segments` are the path parts after /api/v3. */
export function handleRest(
  method: string,
  segments: string[],
  query: Record<string, string>,
  body: unknown,
): RestResult {
  const jsonBody = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null);
  // API root and meta (no repo involved).
  if (segments.length === 0) {
    if (method === 'GET') return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
    return err(404, 'Not Found');
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return err(404, 'Not Found');
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') {
      return ok(200, {
        login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', 0, VIEWER.id), type: 'User',
        name: VIEWER.name, email: VIEWER.email, avatar_url: '', html_url: '', site_admin: false,
        created_at: trialNowIso(), updated_at: trialNowIso(),
      });
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.reposOf(VIEWER.login);
      const { page, link } = paginate(repos, query, '/api/v3/user/repos');
      return ok(200, page.map(repoJson), link);
    }
    if (method === 'POST') {
      if (!jsonBody) return err(400, 'request body must be a JSON object');
      const name = typeof jsonBody.name === 'string' ? jsonBody.name.trim() : '';
      if (name === '' || name.includes('/')) return err(422, 'name is required');
      if (store.getRepo(VIEWER.login, name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(
        VIEWER.login,
        name,
        jsonBody.private === true,
        typeof jsonBody.description === 'string' ? jsonBody.description : '',
      );
      return ok(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1] as string);
    const repoName = decodeURIComponent(segments[2] as string);
    const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return err(404, 'Not Found');
    const rest = segments.slice(3);
    // GET /repos/{o}/{r} | PATCH | DELETE
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        if (!jsonBody) return err(400, 'request body must be a JSON object');
        if (typeof jsonBody.description === 'string') repo.description = jsonBody.description;
        if (typeof jsonBody.default_branch === 'string' && jsonBody.default_branch !== '') repo.defaultBranch = jsonBody.default_branch;
        if (typeof jsonBody.private === 'boolean') repo.isPrivate = jsonBody.private;
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }
    // Branches.
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const out = [...repo.refs.keys()]
          .filter((name) => name.startsWith('refs/heads/'))
          .sort()
          .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) as string }, protected: false }));
        return ok(200, out);
      }
      if (method === 'GET' && rest.length === 2) {
        const name = decodeURIComponent(rest[1] as string);
        const sha = repo.refs.get(`refs/heads/${name}`);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { name, commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }
    // Commits.
    if (rest[0] === 'commits') {
      if (method === 'GET' && rest.length === 1) {
        const shaParam = query.sha ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (isObjectId(shaParam) ? shaParam : undefined) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return ok(200, []);
        const commits = listCommits(repo, peelToCommit(repo, tip) ?? tip, 100);
        return ok(200, commits.map((sha) => {
          const obj = repo.objects.get(sha);
          const parsed = obj ? parseCommit(obj.data) : null;
          return {
            sha,
            commit: {
              message: parsed?.message ?? '',
              author: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
              committer: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
              tree: { sha: parsed?.tree ?? '' },
            },
            author: { login: VIEWER.login, id: VIEWER.id },
            committer: { login: VIEWER.login, id: VIEWER.id },
            parents: (parsed?.parents ?? []).map((p) => ({ sha: p })),
            url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}`,
          };
        }));
      }
      if (method === 'GET' && rest.length === 2) {
        const sha = decodeURIComponent(rest[1] as string);
        const obj = repo.objects.get(sha);
        if (!obj || obj.type !== 'commit') return err(404, 'Not Found');
        const parsed = parseCommit(obj.data);
        return ok(200, {
          sha,
          commit: { message: parsed.message, author: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() }, committer: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() } },
          author: { login: VIEWER.login, id: VIEWER.id },
          parents: parsed.parents.map((p) => ({ sha: p })),
        });
      }
      return err(404, 'Not Found');
    }
    // Git Data API: refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (!jsonBody) return err(400, 'request body must be a JSON object');
        const ref = typeof jsonBody.ref === 'string' ? jsonBody.ref : '';
        const sha = typeof jsonBody.sha === 'string' ? jsonBody.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha)) return err(422, 'ref and sha are required');
        if (!repo.objects.has(sha)) return err(422, 'object does not exist');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        repo.version += 1;
        repo.packCache.clear();
        const obj = repo.objects.get(sha) as { type: string };
        return ok(201, { ref, node_id: globalId('Ref', repo.id, 0), url: '', object: { sha, type: obj.type, url: '' } });
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const out = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
          return ok(200, out);
        }
        const refPath = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
        const sha = repo.refs.get(refPath);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { ref: refPath, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      }
      if (method === 'DELETE' && rest.length > 2) {
        const refPath = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
        if (!repo.refs.has(refPath)) return err(404, 'Not Found');
        repo.refs.delete(refPath);
        repo.version += 1;
        repo.packCache.clear();
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }
    // Contents.
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'PUT') {
        if (!jsonBody) return err(400, 'request body must be a JSON object');
        return putContents(repo, path, jsonBody);
      }
      if (method === 'GET') return getContents(repo, path, query.ref);
      if (method === 'DELETE') return deleteContents(repo, path, jsonBody);
      return err(404, 'Not Found');
    }
    // Labels.
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return ok(200, [...repo.labels.values()].map((l) => ({ id: 0, name: l.name, color: l.color, description: '' })));
      }
      if (method === 'POST' && rest.length === 1) {
        if (!jsonBody) return err(400, 'request body must be a JSON object');
        const name = typeof jsonBody.name === 'string' ? jsonBody.name : '';
        if (name === '') return err(422, 'name is required');
        const color = typeof jsonBody.color === 'string' ? jsonBody.color : 'ededed';
        repo.labels.set(name, { name, color });
        return ok(201, { id: 0, name, color, description: '' });
      }
      return err(404, 'Not Found');
    }
    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let list = [...repo.issues];
          if (query.state && query.state !== 'all') list = list.filter((i) => i.state === query.state);
          const direction = query.direction === 'asc' ? 1 : -1;
          const sort = query.sort ?? 'created';
          if (sort === 'created') list.sort((a, b) => (a.seq - b.seq) * direction);
          const { page, link } = paginate(list, query, `/api/v3/repos/${owner}/${repoName}/issues`);
          return ok(200, page.map((i) => issueJson(repo, i)), link);
        }
        if (method === 'POST') {
          if (!jsonBody) return err(400, 'request body must be a JSON object');
          const title = typeof jsonBody.title === 'string' ? jsonBody.title : '';
          if (title === '') return err(422, 'title is required');
          const labels = Array.isArray(jsonBody.labels) ? jsonBody.labels.map(String) : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return err(422, `label ${label} does not exist`);
          }
          const issue: Issue = {
            id: store.nextObjectId++,
            number: repo.nextIssue++,
            title,
            body: typeof jsonBody.body === 'string' ? jsonBody.body : '',
            state: 'open',
            labels,
            seq: ++store.seq,
            comments: [],
            createdAt: trialNowIso(),
            updatedAt: trialNowIso(),
          };
          repo.issues.push(issue);
          return ok(201, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          if (!jsonBody) return err(400, 'request body must be a JSON object');
          if (typeof jsonBody.state === 'string' && (jsonBody.state === 'open' || jsonBody.state === 'closed')) issue.state = jsonBody.state;
          if (typeof jsonBody.title === 'string') issue.title = jsonBody.title;
          if (typeof jsonBody.body === 'string') issue.body = jsonBody.body;
          issue.updatedAt = trialNowIso();
          return ok(200, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') {
          return ok(200, issue.comments.map((c) => ({
            id: c.id, node_id: globalId('Comment', repo.id, c.id), body: c.body,
            user: { login: VIEWER.login, id: VIEWER.id }, created_at: c.createdAt, updated_at: c.createdAt,
          })));
        }
        if (method === 'POST') {
          if (!jsonBody) return err(400, 'request body must be a JSON object');
          const commentBody = typeof jsonBody.body === 'string' ? jsonBody.body : '';
          const comment = { id: repo.nextCommentId++, body: commentBody, user: VIEWER.login, createdAt: trialNowIso() };
          issue.comments.push(comment);
          issue.updatedAt = trialNowIso();
          return ok(201, {
            id: comment.id, node_id: globalId('Comment', repo.id, comment.id), body: comment.body,
            user: { login: VIEWER.login, id: VIEWER.id }, created_at: comment.createdAt, updated_at: comment.createdAt,
          });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    // Pull requests.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let list = [...repo.pulls];
          const state = query.state ?? 'open';
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page, link } = paginate(list, query, `/api/v3/repos/${owner}/${repoName}/pulls`);
          return ok(200, page.map((p) => pullJson(repo, p)), link);
        }
        if (method === 'POST') {
          if (!jsonBody) return err(400, 'request body must be a JSON object');
          const title = typeof jsonBody.title === 'string' ? jsonBody.title : '';
          const head = typeof jsonBody.head === 'string' ? jsonBody.head : '';
          const base = typeof jsonBody.base === 'string' ? jsonBody.base : repo.defaultBranch;
          if (title === '' || head === '') return err(422, 'title and head are required');
          const headRef = head.includes(':') ? (head.split(':').pop() as string) : head;
          const baseRef = base.includes(':') ? (base.split(':').pop() as string) : base;
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
          const duplicate = repo.pulls.find((p) => p.headRef === headRef && p.baseRef === baseRef && p.state === 'open');
          if (duplicate) return err(422, 'A pull request already exists for this branch');
          const pull: Pull = {
            id: store.nextObjectId++,
            number: repo.nextPull++,
            title,
            body: typeof jsonBody.body === 'string' ? jsonBody.body : '',
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
          return ok(201, pullJson(repo, pull));
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, pullJson(repo, pull));
        return err(404, 'Not Found');
      }
      if (rest[2] === 'files' && method === 'GET') {
        return ok(200, pullFiles(repo, pull));
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        return mergePullRequest(repo, pull);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}
