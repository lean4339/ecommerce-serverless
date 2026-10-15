// Pasada en modo DATA_BACKEND=dynamo contra DynamoDB Local (DYNAMO_ENDPOINT).
// Crea una tabla desechable con datos mínimos y la borra al terminar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Context } from 'aws-lambda';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Event, Result } from '../src/shared/http.js';
import { routes } from '../src/routes.js';

process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
process.env.LOCAL_DEVELOPMENT = 'true';
process.env.DATA_BACKEND = 'dynamo';
process.env.TABLE_NAME = `nexo-test-${randomUUID().slice(0, 8)}`;
const endpoint = process.env.DYNAMO_ENDPOINT;

test('Tienda en modo DynamoDB (DynamoDB Local)', { skip: !endpoint }, async (t) => {
  const TableName = process.env.TABLE_NAME!;
  const raw = new DynamoDBClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const doc = DynamoDBDocumentClient.from(raw);
  await raw.send(
    new CreateTableCommand({
      TableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map((n) => ({
        AttributeName: n,
        AttributeType: 'S',
      })),
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  await waitUntilTableExists({ client: raw, maxWaitTime: 30 }, { TableName });
  t.after(async () => {
    await raw.send(new DeleteTableCommand({ TableName }));
  });
  const pad = (id: string) => id.padStart(19, '0');
  const product = (id: string, name: string, stock: number[]) => [
    {
      PK: `PRODUCT#${id}`,
      SK: 'META',
      type: 'PRODUCT',
      productId: id,
      name,
      description: `${name} de prueba`,
      basePriceCents: '1000',
      priceCents: '1000',
      categoryId: '1',
      categoryName: 'Cat',
      brandId: '1',
      brandName: 'Marca',
      sellerName: 'Vendedor',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      availableUnits: stock.reduce((a, b) => a + b, 0),
      reviewCount: '0',
      soldUnits: '0',
      views: '0',
      reviews: [],
      related: [],
      GSI1PK: 'CAT#1',
      GSI1SK: `PRODUCT#${name}#${pad(id)}`,
      GSI2PK: 'CATALOG',
      GSI2SK: `${String(10n ** 15n).padStart(16, '0')}#${pad(id)}`,
    },
    ...stock.flatMap((units, i) => {
      const variantId = `${id}${i}`;
      return [
        {
          PK: `PRODUCT#${id}`,
          SK: `VARIANT#${pad(variantId)}`,
          type: 'VARIANT',
          variantId,
          productId: id,
          sku: `SKU-${variantId}`,
          color: 'rojo',
          size: 'M',
          priceCents: '1000',
          stock: units,
        },
        { PK: `VARIANT#${variantId}`, SK: 'META', variantId, productId: id },
      ];
    }),
  ];
  const fixtures = [
    { PK: 'COUNTER', SK: 'ID', n: 1000000000000 },
    { PK: 'FILTERS', SK: 'STATS', activeProducts: 2 },
    { PK: 'FILTERS', SK: 'CAT#1', categoryId: '1', name: 'Cat', products: '2', rank: 1 },
    { PK: 'FILTERS', SK: 'BRAND#1', brandId: '1', name: 'Marca', products: '2', rank: 1 },
    ...product('1', 'Mate', [3, 0]),
    ...product('2', 'Termo', [5]),
  ];
  for (let i = 0; i < fixtures.length; i += 25) {
    await doc.send(
      new BatchWriteCommand({
        RequestItems: {
          [TableName]: fixtures.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
        },
      }),
    );
  }

  const handlers = new Map<string, (e: Event, c: Context) => Promise<Result>>();
  for (const name of new Set(routes.map((r) => r.name))) {
    handlers.set(
      name,
      ((await import(`../src/functions/${name}.js`)) as { handler: never }).handler,
    );
  }
  async function call(
    method: string,
    path: string,
    options: {
      body?: unknown;
      cookie?: string;
      key?: string;
      id?: string;
      query?: Record<string, string>;
      ip?: string;
    } = {},
  ) {
    const route = routes.find((r) => r.method === method && r.path === path)!;
    const event = {
      version: '2.0',
      routeKey: `${method} ${path}`,
      rawPath: path,
      rawQueryString: '',
      isBase64Encoded: false,
      headers: {
        origin: process.env.APP_ORIGIN!,
        ...(options.key ? { 'idempotency-key': options.key } : {}),
      },
      cookies: options.cookie ? [options.cookie] : undefined,
      queryStringParameters: options.query,
      pathParameters: options.id ? { id: options.id } : {},
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      requestContext: {
        requestId: randomUUID(),
        http: {
          method,
          path,
          sourceIp: options.ip ?? '10.0.0.1',
          protocol: 'HTTP/1.1',
          userAgent: 'test',
        },
      },
    } as unknown as Event;
    const response = await handlers.get(route.name)!(event, {
      awsRequestId: randomUUID(),
    } as Context);
    return {
      status: response.statusCode,
      body: JSON.parse(response.body),
      cookie: response.cookies?.[0]?.split(';')[0],
    };
  }

  const email = `ana.${Date.now()}@example.com`;
  const password = 'clave-segura-de-prueba';
  let cookie = '';

  await t.test('Registro, sesión, email duplicado y login', async () => {
    const signup = await call('POST', '/api/v1/auth/signup', {
      body: { full_name: 'Ana Prueba', email: email.toUpperCase(), password },
    });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.data.email, email);
    assert.match(signup.body.data.id, /^\d+$/);
    const again = await call('POST', '/api/v1/auth/signup', {
      body: { full_name: 'Otra', email, password },
    });
    assert.equal(again.status, 409);
    const session = await call('GET', '/api/v1/auth/session', { cookie: signup.cookie });
    assert.deepEqual(session.body.data, signup.body.data);
    const bad = await call('POST', '/api/v1/auth/login', {
      body: { email, password: 'incorrecta' },
    });
    assert.equal(bad.status, 401);
    const login = await call('POST', '/api/v1/auth/login', {
      body: { email, password },
      cookie: signup.cookie,
    });
    assert.equal(login.status, 200);
    // El login rota la sesión: la cookie anterior deja de valer.
    assert.equal((await call('GET', '/api/v1/cart', { cookie: signup.cookie })).status, 401);
    cookie = login.cookie!;
    assert.equal((await call('GET', '/api/v1/cart', { cookie })).status, 200);
    assert.equal((await call('GET', '/api/v1/cart')).status, 401);
  });

  await t.test('Catálogo, ficha y filtros', async () => {
    const list = await call('GET', '/api/v1/store/products', {
      cookie,
      query: { category_id: '1', sort: 'price_asc', q: 'term' },
    });
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.data.map((p: { id: string }) => p.id),
      ['2'],
    );
    assert.equal(list.body.total, '1');
    const home = await call('GET', '/api/v1/store/products', { cookie, query: { limit: '1' } });
    assert.deepEqual(
      home.body.data.map((p: { id: string }) => p.id),
      ['1'],
    );
    assert.equal(home.body.total, '2');
    const first = await call('GET', '/api/v1/store/products', {
      cookie,
      query: { limit: '1', cursor: '' },
    });
    const second = await call('GET', '/api/v1/store/products', {
      cookie,
      query: { limit: '1', cursor: first.body.next_cursor },
    });
    assert.deepEqual(
      [...first.body.data, ...second.body.data].map((p: { id: string }) => p.id),
      ['1', '2'],
    );
    assert.equal(second.body.next_cursor, null);
    const detail = await call('GET', '/api/v1/store/products/{id}', { cookie, id: '1' });
    assert.deepEqual(
      detail.body.data.variants.map((v: { available_units: string }) => v.available_units),
      ['3', '0'],
    );
    const filters = await call('GET', '/api/v1/store/filters', { cookie });
    assert.deepEqual(filters.body.categories, [
      { id: '1', name: 'Cat', parent_id: null, products: '2' },
    ]);
  });

  let addressId = '';
  await t.test('Carrito con versión optimista y stock', async () => {
    const empty = await call('GET', '/api/v1/cart', { cookie });
    assert.deepEqual(empty.body.data, { version: 0, items: [], total_cents: '0' });
    const tooMuch = await call('PUT', '/api/v1/cart', {
      cookie,
      body: { version: 0, items: [{ variant_id: '10', quantity: 4 }] },
    });
    assert.equal(tooMuch.status, 409);
    const put = await call('PUT', '/api/v1/cart', {
      cookie,
      body: {
        version: 0,
        items: [
          { variant_id: '10', quantity: 2 },
          { variant_id: '20', quantity: 1 },
        ],
      },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.data.version, 1);
    assert.equal(put.body.data.total_cents, '3000');
    const stale = await call('PUT', '/api/v1/cart', { cookie, body: { version: 0, items: [] } });
    assert.equal(stale.status, 409);
    const address = await call('POST', '/api/v1/store/customer/addresses', {
      cookie,
      body: { street: 'Calle 1', city: 'CABA', country: 'AR', postal_code: '1000' },
    });
    assert.equal(address.status, 201);
    addressId = address.body.data.id;
    const customer = await call('GET', '/api/v1/store/customer', { cookie });
    assert.equal(customer.body.data.addresses[0].id, addressId);
  });

  let orderId = '';
  let orderId2 = '';
  await t.test('Pedido: transacción, idempotencia y reintento con otra clave', async () => {
    const key = randomUUID();
    const order = await call('POST', '/api/v1/orders', {
      cookie,
      key,
      body: { address_id: addressId, cart_version: 1 },
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(order.body.replayed, false);
    assert.equal(order.body.data.total_cents, '3000');
    assert.equal(order.body.data.items.length, 2);
    assert.equal(order.body.data.status_history[0].status, 'created');
    orderId = order.body.data.id;
    const replay = await call('POST', '/api/v1/orders', {
      cookie,
      key,
      body: { address_id: addressId, cart_version: 1 },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.data.id, orderId);
    const mismatch = await call('POST', '/api/v1/orders', {
      cookie,
      key,
      body: { address_id: addressId, cart_version: 2 },
    });
    assert.equal(mismatch.status, 409);
    const cart = await call('GET', '/api/v1/cart', { cookie });
    assert.deepEqual(cart.body.data, { version: 2, items: [], total_cents: '0' });
    const detail = await call('GET', '/api/v1/store/products/{id}', { cookie, id: '1' });
    assert.equal(detail.body.data.variants[0].available_units, '1');
  });

  await t.test('Sin stock: 409 y nada cambia', async () => {
    const put = await call('PUT', '/api/v1/cart', {
      cookie,
      body: { version: 2, items: [{ variant_id: '10', quantity: 1 }] },
    });
    assert.equal(put.status, 200);
    // Otra compra se lleva la última unidad entre el carrito y la confirmación.
    const other = `bea.${Date.now()}@example.com`;
    const s2 = await call('POST', '/api/v1/auth/signup', {
      body: { full_name: 'Bea', email: other, password },
    });
    const c2 = s2.cookie!;
    const a2 = await call('POST', '/api/v1/store/customer/addresses', {
      cookie: c2,
      body: { street: 'X 2', city: 'CABA', country: 'AR', postal_code: '1000' },
    });
    await call('PUT', '/api/v1/cart', {
      cookie: c2,
      body: { version: 0, items: [{ variant_id: '10', quantity: 1 }] },
    });
    const winner = await call('POST', '/api/v1/orders', {
      cookie: c2,
      key: randomUUID(),
      body: { address_id: a2.body.data.id, cart_version: 1 },
    });
    assert.equal(winner.status, 201);
    const loser = await call('POST', '/api/v1/orders', {
      cookie,
      key: randomUUID(),
      body: { address_id: addressId, cart_version: 3 },
    });
    assert.equal(loser.status, 409);
    assert.match(loser.body.error, /Stock insuficiente/);
    const cart = await call('GET', '/api/v1/cart', { cookie });
    assert.equal(cart.body.data.version, 3);
    assert.equal(cart.body.data.items.length, 1);
    const detail = await call('GET', '/api/v1/store/products/{id}', { cookie, id: '1' });
    assert.equal(detail.body.data.variants[0].available_units, '0');
    const foreign = await call('GET', '/api/v1/orders/{id}', { cookie: c2, id: orderId });
    assert.equal(foreign.status, 404);
  });

  await t.test('Dos reintentos concurrentes con la misma clave crean un solo pedido', async () => {
    const put = await call('PUT', '/api/v1/cart', {
      cookie,
      body: { version: 3, items: [{ variant_id: '20', quantity: 1 }] },
    });
    assert.equal(put.status, 200);
    const key = randomUUID();
    const both = await Promise.all(
      [0, 1].map(() =>
        call('POST', '/api/v1/orders', {
          cookie,
          key,
          body: { address_id: addressId, cart_version: 4 },
        }),
      ),
    );
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 201]);
    assert.equal(both[0]!.body.data.id, both[1]!.body.data.id);
    const detail = await call('GET', '/api/v1/store/products/{id}', { cookie, id: '2' });
    assert.equal(detail.body.data.variants[0].available_units, '3');
    orderId2 = both[0]!.body.data.id;
  });

  await t.test('Listado, detalle de pedido y logout', async () => {
    const orders = await call('GET', '/api/v1/orders', { cookie });
    assert.equal(orders.status, 200);
    assert.deepEqual(
      orders.body.data.map((o: { id: string }) => o.id),
      [orderId2, orderId],
    );
    assert.equal(orders.body.next_before_id, null);
    const order = await call('GET', '/api/v1/orders/{id}', { cookie, id: orderId });
    assert.equal(order.body.data.address.city, 'CABA');
    const out = await call('POST', '/api/v1/auth/logout', { cookie });
    assert.equal(out.status, 200);
    assert.equal((await call('GET', '/api/v1/orders', { cookie })).status, 401);
  });

  await t.test('Límite de intentos de login con contador atómico', async () => {
    const statuses: number[] = [];
    const target = `nadie.${Date.now()}@example.com`;
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await call('POST', '/api/v1/auth/login', {
            body: { email: target, password: 'x' },
            ip: `10.9.0.${i}`,
          })
        ).status,
      );
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[10], 429);
  });
});
