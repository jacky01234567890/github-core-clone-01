// app.ts — the forge's HTTP server: one process, one shared store, four surfaces.
//
// Routing:
//   GET  /healthz            boot probe -> 200 {"ok":true} (no auth)
//   /api/v3/...              REST v3 (rest.ts)
//   POST /api/graphql        GraphQL v4 (graphql.ts)
//   POST /mcp                MCP over Streamable HTTP (mcp.ts)
//   /<owner>/<repo>.git/...  git smart HTTP (git.ts)
//   anything else            404 {"message":"Not Found"}
//
// Auth: Authorization: Bearer $MAKEFUN_SHOP_TOKEN. A missing/wrong token is
// refused (401) by the surface handlers; /healthz takes none. When
// MAKEFUN_SHOP_TOKEN is unset (local runs), the test token 'test-token' is used.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Store } from './store.ts';
import { handleRestRequest } from './rest.ts';
import { handleGraphqlRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import { handleGitRequest } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';

type HandlerResult = {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
};

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendResult(res: ServerResponse, result: HandlerResult): void {
  const body = typeof result.body === 'string' ? Buffer.from(result.body, 'utf8') : result.body;
  const headers: Record<string, string> = { ...result.headers };
  if (headers['content-length'] === undefined) headers['content-length'] = String(body.length);
  res.writeHead(result.status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  sendResult(res, {
    status,
    headers: { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), ...headers },
    body: Buffer.from(text, 'utf8'),
  });
}

/** Read the whole request body (capped at 128 MiB; pushes carry packfiles). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Lower-cased plain-object view of the request headers. */
function headerRecord(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(', ');
  }
  return out;
}

function isAuthed(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  return auth === `Bearer ${TOKEN}`;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const rawUrl = req.url ?? '/';
        let url: URL;
        try {
          // Base on the request's own Host so url.origin is the real origin
          // (the REST handler builds absolute Link URLs from it).
          url = new URL(rawUrl, `http://${req.headers.host ?? 'entry'}`);
        } catch {
          sendJson(res, 400, { message: 'Bad Request' });
          return;
        }
        const path = url.pathname;

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const authed = isAuthed(req);
        const body = await readBody(req);
        const headers = new Headers(headerRecord(req));
        const headerObj = headerRecord(req);

        // REST v3 (handles its own 401s and the /api/v3/ root).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const result = await handleRestRequest(method, url, headers, body, store, authed);
          if (result !== null) {
            sendResult(res, result);
            return;
          }
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          const result = await handleGraphqlRequest(method, rawUrl, headerObj, body, store, authed);
          if (result !== null) {
            sendResult(res, result);
            return;
          }
        }

        // MCP.
        if (path === '/mcp') {
          const result = await handleMcpRequest(method, rawUrl, headerObj, body, store, authed);
          if (result !== null) {
            sendResult(res, result);
            return;
          }
        }

        // git smart HTTP: /<owner>/<repo>.git/...
        if (/^\/[^/]+\/[^/]+\.git(\/|$)/.test(path)) {
          const result = await handleGitRequest(method, url, headers, body, store, authed);
          if (result !== null) {
            sendResult(res, result);
            return;
          }
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        process.stderr.write(`[app] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
