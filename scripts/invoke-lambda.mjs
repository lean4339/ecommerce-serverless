import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { routes } from '../dist/src/routes.js';
const [name = 'list-products', file = 'events/list-products.json'] = process.argv.slice(2);
if (!routes.some((route) => route.name === name)) throw Error('Función desconocida: ' + name);
const { handler } = await import(`../dist/src/functions/${name}.js`);
const response = await handler(JSON.parse(await readFile(file, 'utf8')), {
  awsRequestId: 'local-' + randomUUID(),
  callbackWaitsForEmptyEventLoop: false,
});
console.log(JSON.stringify(response, null, 2));
process.exit(response.statusCode >= 400 ? 1 : 0);
