import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Context } from 'aws-lambda';
import type { Event, Result } from './shared/http.js';
import { routes } from './routes.js';

// Adaptador exclusivamente local. No se empaqueta ni existe como Lambda en AWS.
const app = Fastify({ bodyLimit: 64 * 1024 });
for (const route of routes) {
  const { handler } = (await import(`./functions/${route.name}.js`)) as {
    handler: (e: Event, c: Context) => Promise<Result>;
  };
  app.route({
    method: route.method,
    url: route.path.replace('{id}', ':id'),
    handler: async (req, reply) => {
      const parsed = new URL(req.url, 'http://localhost');
      const requestId = randomUUID();
      const event = {
        version: '2.0',
        routeKey: `${route.method} ${route.path}`,
        rawPath: parsed.pathname,
        rawQueryString: parsed.search.slice(1),
        headers: req.headers,
        cookies: req.headers.cookie ? [req.headers.cookie] : undefined,
        pathParameters: req.params,
        queryStringParameters: Object.fromEntries(parsed.searchParams),
        isBase64Encoded: false,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        requestContext: {
          requestId,
          http: {
            method: req.method,
            path: parsed.pathname,
            sourceIp: req.ip,
            protocol: 'HTTP/1.1',
            userAgent: 'local',
          },
        },
      } as Event;
      const result = await handler(event, {
        awsRequestId: requestId,
        callbackWaitsForEmptyEventLoop: false,
      } as Context);
      reply
        .code(result.statusCode)
        .headers(
          Object.fromEntries(Object.entries(result.headers ?? {}).map(([k, v]) => [k, String(v)])),
        );
      if (result.cookies) {
        reply.header('set-cookie', result.cookies);
      }
      return result.body;
    },
  });
}
const ui = resolve('frontend/dist');
if (existsSync(ui)) {
  await app.register(staticFiles, { root: ui });
}
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
console.log('Tienda local: http://127.0.0.1:' + String(process.env.PORT ?? 3000));
console.log('Login y registro contra PostgreSQL: las Lambdas validan la cookie de sesión.');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
