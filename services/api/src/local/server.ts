import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handler as askHandler } from '../handlers/ask.js';
import { handler as ingestHandler } from '../handlers/ingest.js';
import { CORS_HEADERS } from '../http.js';

/**
 * Local development server.
 *
 * It builds an API Gateway v2 event and invokes the real Lambda handlers, so
 * what runs on a laptop is the same code path that runs deployed — validation,
 * error mapping and all. It is deliberately not an Express app with its own
 * routes, because that would be a second implementation to keep in sync.
 */

const ENV_FILE = resolve(process.cwd(), '../../.env');
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const PORT = Number(process.env['PORT'] ?? 4000);

function buildEvent(path: string, method: string, body: string): APIGatewayProxyEventV2 {
  const now = new Date();
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: `localhost:${PORT}`,
      domainPrefix: 'localhost',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'local-dev-server',
      },
      requestId: `local-${now.getTime()}`,
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: now.toISOString(),
      timeEpoch: now.getTime(),
    },
    body,
    isBase64Encoded: false,
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, result: APIGatewayProxyStructuredResultV2): void {
  response.writeHead(result.statusCode ?? 200, {
    'Content-Type': 'application/json',
    ...CORS_HEADERS,
    ...(result.headers ?? {}),
  });
  response.end(result.body ?? '');
}

const ROUTES = {
  '/ingest': ingestHandler,
  '/ask': askHandler,
} as const;

function isKnownRoute(path: string): path is keyof typeof ROUTES {
  return path in ROUTES;
}

const server = createServer((request, response) => {
  void (async () => {
    const method = request.method ?? 'GET';
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    if (method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }

    if (method === 'GET' && path === '/health') {
      send(response, { statusCode: 200, body: JSON.stringify({ status: 'ok' }) });
      return;
    }

    if (method !== 'POST' || !isKnownRoute(path)) {
      // Not an API error: routing is API Gateway's job in a deployment, and it
      // answers an unknown path itself. Labelling this INVALID_INPUT would
      // describe the caller's body when the problem is the URL, and would put a
      // code in a response the deployed API never produces.
      send(response, {
        statusCode: 404,
        body: JSON.stringify({
          message: `No route for ${method} ${path}. This server exposes POST /ingest, POST /ask and GET /health.`,
        }),
      });
      return;
    }

    const body = await readBody(request);
    const result = await ROUTES[path](buildEvent(path, method, body));
    send(response, result);
  })().catch((error: unknown) => {
    console.error('Local server error', error);
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } }));
  });
});

server.listen(PORT, () => {
  console.log(`Doc Q&A API listening on http://localhost:${PORT}`);
  console.log(`  POST http://localhost:${PORT}/ingest`);
  console.log(`  POST http://localhost:${PORT}/ask`);
});
