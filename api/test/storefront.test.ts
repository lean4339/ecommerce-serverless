import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Context } from 'aws-lambda';
import type pg from 'pg';
import { createPool } from '../src/db.js';
import { lambda, type Event, type Operation } from '../src/shared/http.js';
import { routes, functionNames } from '../src/routes.js';

process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
process.env.LOCAL_DEVELOPMENT = 'true';

test('Tienda: handlers contra PostgreSQL real y aislado', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Usá npm test para crear una DB desechable');
  const pool = createPool(process.env.TEST_DATABASE_URL);
  const logs: Record<string, unknown>[] = [];
  const handlers = new Map<string, ReturnType<typeof lambda>>();
  for (const route of routes.filter((route) => route.name !== 'auth')) {
    const { execute } = (await import(`../src/functions/${route.name}.js`)) as {
      execute: Operation;
    };
    for (const customerId of ['1', '2']) {
      handlers.set(
        `${customerId}:${route.name}`,
        lambda(route.name, execute, { pool, customerId, log: (r) => logs.push(r) }),
      );
    }
  }
  async function call(
    name: string,
    options: {
      customer?: string;
      body?: unknown;
      query?: Record<string, string>;
      id?: string;
      key?: string;
    } = {},
  ) {
    const route = routes.find((route) => route.name === name)!;
    const requestId = randomUUID();
    const event = {
      version: '2.0',
      rawPath: route.path,
      routeKey: `${route.method} ${route.path}`,
      rawQueryString: '',
      isBase64Encoded: false,
      headers: {
        origin: process.env.APP_ORIGIN,
        ...(options.key ? { 'idempotency-key': options.key } : {}),
      },
      queryStringParameters: options.query,
      pathParameters: options.id ? { id: options.id } : {},
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      requestContext: {
        routeKey: `${route.method} ${route.path}`,
        accountId: 'local',
        apiId: 'local',
        domainName: 'localhost',
        domainPrefix: 'local',
        stage: '$default',
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
        requestId: 'gateway-' + requestId,
        http: {
          method: route.method,
          path: route.path,
          sourceIp: '127.0.0.1',
          protocol: 'HTTP/1.1',
          userAgent: 'test',
        },
      },
    } as Event;
    const response = await handlers.get(`${options.customer ?? '1'}:${name}`)!(event, {
      awsRequestId: requestId,
    } as Context);
    return {
      status: response.statusCode,
      body: JSON.parse(response.body),
      headers: response.headers,
      requestId,
    };
  }
  async function cart(items: { variant_id: string; quantity: number }[], customer = '1') {
    const current = await call('get-cart', { customer });
    const result = await call('update-cart', {
      customer,
      body: { version: current.body.data.version, items },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.data;
  }
  const buy = (version: number, key: string = randomUUID(), customer = '1', address = customer) =>
    call('create-order', { customer, key, body: { cart_version: version, address_id: address } });
  try {
    await t.test('Catálogo, filtros, ficha y cliente; entrada validada', async () => {
      assert.equal(functionNames.length, 11);
      assert.equal(routes.length, 14);
      const list = await call('list-products', {
        query: { sort: 'price_asc', in_stock: 'true', limit: '2' },
      });
      assert.equal(list.status, 200);
      assert.equal(list.body.data.length, 2);
      assert.equal(list.body.total, '15');
      assert.ok(BigInt(list.body.data[0].price_cents) <= BigInt(list.body.data[1].price_cents));
      const product = await call('get-product', { id: list.body.data[0].id });
      assert.equal(product.status, 200);
      assert.ok(product.body.data.variants.length > 0);
      assert.ok((await call('get-filters')).body.categories.length > 0);
      assert.equal((await call('get-customer')).body.data.id, '1');
      assert.equal((await call('get-product', { id: '9223372036854775808' })).status, 400);
      assert.equal((await call('get-product', { id: '999999999' })).status, 404);
      const invalidQueries: Record<string, string>[] = [
        { page: '0' },
        { limit: '49' },
        { sort: 'drop' },
        { min_rating: '6' },
        { in_stock: 'yes' },
        { min_cents: '200', max_cents: '100' },
      ];
      for (const query of invalidQueries) {
        assert.equal((await call('list-products', { query })).status, 400);
      }
      assert.equal(
        (await call('list-products', { query: { q: 'zzzz-no-existe' } })).body.total,
        '0',
      );
    });
    await t.test(
      'Carrito persistente: agregar, modificar, quitar, versión y precios del servidor',
      async () => {
        const first = await cart([{ variant_id: '1', quantity: 1 }]);
        const current = await call('get-cart');
        assert.equal(current.body.data.items[0].quantity, 1);
        assert.equal(
          (await call('update-cart', { body: { version: first.version - 1, items: [] } })).status,
          409,
        );
        const updated = await cart([{ variant_id: '1', quantity: 2 }]);
        assert.equal(updated.total_cents, (BigInt(updated.items[0].price_cents) * 2n).toString());
        const malformed = [
          { variant_id: '1', quantity: 0 },
          { variant_id: '1', quantity: 1, price_cents: '1' },
        ];
        for (const item of malformed) {
          assert.equal(
            (await call('update-cart', { body: { version: updated.version, items: [item] } }))
              .status,
            400,
          );
        }
        assert.equal(
          (
            await call('update-cart', {
              body: {
                version: updated.version,
                items: [
                  { variant_id: '1', quantity: 1 },
                  { variant_id: '1', quantity: 1 },
                ],
              },
            })
          ).status,
          400,
        );
        assert.equal((await cart([])).items.length, 0);
      },
    );
    await t.test(
      'Confirmar guarda detalle, historial, stock y vacía el carrito atómicamente',
      async () => {
        const saved = await cart([{ variant_id: '1', quantity: 2 }]);
        const before = (
          await pool.query('SELECT reserved FROM inventory WHERE variant_id=1')
        ).rows.reduce((n, r) => n + r.reserved, 0);
        const result = await buy(saved.version);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        const order = result.body.data;
        assert.equal(order.status, 'created');
        assert.equal(order.items[0].quantity, 2);
        assert.equal(order.total_cents, saved.total_cents);
        assert.equal(order.status_history[0].status, 'created');
        const after = (
          await pool.query('SELECT reserved FROM inventory WHERE variant_id=1')
        ).rows.reduce((n, r) => n + r.reserved, 0);
        assert.equal(after - before, 2);
        assert.equal((await call('get-cart')).body.data.items.length, 0);
        assert.equal((await call('get-order', { id: order.id })).body.data.id, order.id);
        assert.equal((await call('get-order', { id: order.id, customer: '2' })).status, 404);
        assert.equal((await call('list-orders')).body.data[0].id, order.id);
        assert.ok(logs.some((row) => row.event === 'order.created' && row.orderId === order.id));
      },
    );
    await t.test(
      'Dos reintentos concurrentes con la misma clave generan un solo pedido',
      async () => {
        const saved = await cart([{ variant_id: '2', quantity: 1 }]);
        const key = randomUUID();
        const results = await Promise.all([buy(saved.version, key), buy(saved.version, key)]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
        assert.equal(results[0]!.body.data.id, results[1]!.body.data.id);
        assert.equal((await buy(saved.version, key)).status, 200);
        assert.equal((await buy(saved.version + 1, key)).status, 409);
        assert.equal(
          (await pool.query('SELECT count(*) FROM store_checkouts WHERE request_key=$1', [key]))
            .rows[0].count,
          '1',
        );
      },
    );
    await t.test('Dirección ajena, versión vieja y claves inválidas no crean pedidos', async () => {
      const saved = await cart([{ variant_id: '3', quantity: 1 }]);
      assert.equal((await buy(saved.version, randomUUID(), '1', '2')).status, 400);
      assert.equal((await buy(saved.version - 1)).status, 409);
      assert.equal((await buy(saved.version, 'invalid')).status, 400);
      assert.equal(
        (
          await call('create-order', {
            key: randomUUID(),
            body: { address_id: '1', cart_version: saved.version, user_id: '2' },
          })
        ).status,
        400,
      );
      assert.equal((await call('get-cart')).body.data.items.length, 1);
    });
    await t.test(
      'Rollback: si un artículo pierde stock no queda reserva parcial ni se borra el carrito',
      async () => {
        await pool.query('UPDATE inventory SET reserved=0,quantity=10 WHERE variant_id IN (3,4)');
        const saved = await cart([
          { variant_id: '3', quantity: 1 },
          { variant_id: '4', quantity: 1 },
        ]);
        await pool.query('UPDATE inventory SET quantity=0 WHERE variant_id=4');
        const result = await buy(saved.version);
        assert.equal(result.status, 409);
        assert.equal(
          (await pool.query('SELECT sum(reserved) AS n FROM inventory WHERE variant_id=3')).rows[0]
            .n,
          '0',
        );
        assert.equal((await call('get-cart')).body.data.items.length, 2);
        await cart([]);
      },
    );
    await t.test(
      'Dos compradores disputan la última unidad: uno confirma y otro recibe 409',
      async () => {
        await pool.query('UPDATE inventory SET quantity=1,reserved=0 WHERE variant_id=5');
        const one = await cart([{ variant_id: '5', quantity: 1 }], '1');
        const two = await cart([{ variant_id: '5', quantity: 1 }], '2');
        const results = await Promise.all([
          buy(one.version, randomUUID(), '1'),
          buy(two.version, randomUUID(), '2'),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        assert.equal(
          (await pool.query('SELECT sum(reserved) AS n FROM inventory WHERE variant_id=5')).rows[0]
            .n,
          '1',
        );
      },
    );
    await t.test(
      'Importes BIGINT conservan precisión mayor a Number.MAX_SAFE_INTEGER',
      async () => {
        await pool.query('UPDATE product_variants SET price_cents=9007199254740993 WHERE id=6');
        const saved = await cart([{ variant_id: '6', quantity: 2 }]);
        const result = await buy(saved.version);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.equal(result.body.data.total_cents, '18014398509481986');
      },
    );
    await t.test(
      'Cada handler devuelve correlación propia y conserva estado caliente',
      async () => {
        const one = await call('get-filters');
        const two = await call('get-filters');
        assert.notEqual(one.requestId, two.requestId);
        assert.equal(one.headers?.['x-lambda-function'], 'get-filters');
        assert.equal(one.headers?.['x-request-id'], one.requestId);
        const starts = logs.filter(
          (r) => r.function === 'get-filters' && r.event === 'request.start',
        );
        assert.equal(starts[0]!.coldStart, true);
        assert.equal(starts.at(-1)!.coldStart, false);
        assert.ok(!JSON.stringify(logs).includes('@example.test'));
      },
    );
  } finally {
    await pool.end();
  }
});

test('Errores de infraestructura devuelven 503 sin filtrar datos de conexión', async () => {
  const logs: Record<string, unknown>[] = [];
  const pool = {
    query: async () => {
      throw Object.assign(new Error('password=SECRET'), { code: 'ECONNREFUSED' });
    },
  } as unknown as pg.Pool;
  const handler = lambda(
    'failure',
    async (_event, { pool }) => {
      await pool.query('SELECT 1');
      throw Error('unreachable');
    },
    { pool, customerId: '1', log: (r) => logs.push(r) },
  );
  const event = { version: '2.0', requestContext: { http: { method: 'GET' } } } as Event;
  const response = await handler(event, { awsRequestId: 'failure-test' } as Context);
  assert.equal(response.statusCode, 503);
  assert.ok(!JSON.stringify([logs, response]).includes('SECRET'));
});
