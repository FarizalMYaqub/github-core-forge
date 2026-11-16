// The forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP in one
// Node process, over the shared in-memory store. Every reply carries a
// deterministic X-GitHub-Request-Id; every REST reply is JSON.
//
// Routing: /healthz (no auth), /{owner}/{repo}.git/* (git smart HTTP, no auth),
// /mcp (own auth/parse handling), /api/graphql (bearer auth), /api/v3/* (bearer
// auth except the root and /meta, which the suite reads unauthenticated).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleUploadPack, handleReceivePack, handleGitRaw } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 128 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    url.searchParams.forEach((value, key) => {
      out[key] = value;
    });
  } catch {
    // No query string.
  }
  return out;
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token this process expects, when the env sets one. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  if (expected !== '') return auth.slice('Bearer '.length) === expected;
  return true;
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const segments = path.split('/').filter((part) => part !== '');

      // The env's boot check: 200 {"ok":true}, no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // --- git smart HTTP: /{owner}/{repo}.git/info/refs and the pack endpoints.
      const gitMatch = path.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/);
      if (gitMatch && (method === 'GET' || method === 'POST')) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const endpoint = gitMatch[3] as string;
        if (endpoint === 'info/refs') {
          const query = queryOf(req);
          const service = query.service ?? '';
          const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          const result = handleInfoRefs(owner, repoName, service, wantsV2 && service === 'git-upload-pack');
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        const body = await readBody(req);
        if (endpoint === 'git-upload-pack') {
          const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          const result = handleUploadPack(owner, repoName, body, wantsV2);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        const result = handleReceivePack(owner, repoName, body);
        sendBuffer(res, result.status, result.contentType, result.body);
        return;
      }

      // --- MCP: its handler owns auth and parse-error answers.
      if (path === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const rawBody = (await readBody(req)).toString('utf8');
        const result = handleMcp(rawBody, req.headers as Record<string, string | undefined>);
        if (result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': requestId(), ...(result.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      // --- GraphQL v4.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!authorized(req)) {
          unauthorized(res);
          return;
        }
        const rawBody = (await readBody(req)).toString('utf8');
        let body: unknown;
        try {
          body = JSON.parse(rawBody);
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const result = handleGraphQL(body);
        sendJson(res, result.status, result.body);
        return;
      }

      // --- REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const restSegments = segments.slice(2);
        const isRoot = restSegments.length === 0;
        const isMeta = restSegments.length === 1 && restSegments[0] === 'meta';
        if (!isRoot && !isMeta && !authorized(req)) {
          unauthorized(res);
          return;
        }
        let body: unknown = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const rawBody = (await readBody(req)).toString('utf8');
          if (rawBody.trim() !== '') {
            try {
              body = JSON.parse(rawBody);
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
          }
        }
        const result = handleRest(method, restSegments, queryOf(req), body);
        const headers: Record<string, string> = {};
        if (isRoot) headers['x-oauth-scopes'] = 'repo, read:org';
        if (result.link) {
          const link = result.link.startsWith('http') ? result.link : `${originOf(req)}${result.link}`;
          headers.link = `<${link}>; rel="next"`;
        }
        sendJson(res, result.status, result.body, headers);
        return;
      }

      // Everything else: GitHub's JSON 404.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.end();
      }
    });
  });
}
