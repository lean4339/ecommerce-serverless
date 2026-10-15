// Regresión de API por endpoint (solo stack local): códigos de estado y forma de respuesta.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Api, live, newAccount, shape } from './helpers';

test.skip(live, 'La regresión completa de API corre contra el stack local');

test('API: estados y formas de las 14 rutas', async ({ request, baseURL }) => {
  const api = new Api(request, new URL(baseURL!).origin);
  const s = (v: unknown) => shape(v);

  expect((await api.call('GET', '/store/products')).status).toBe(401);
  expect((await api.call('GET', '/auth/session')).status).toBe(401);
  const account = newAccount();
  expect(
    (await api.call('POST', '/auth/signup', account, { origin: 'https://evil.example' })).status,
  ).toBe(403);
  expect((await api.call('POST', '/auth/signup', { ...account, password: 'corta' })).status).toBe(
    400,
  );

  const signup = await api.call('POST', '/auth/signup', account);
  expect(signup.status).toBe(201);
  expect(s(signup.body)).toEqual({ data: { id: 'string', full_name: 'string', email: 'string' } });
  expect((await api.call('POST', '/auth/signup', account)).status).toBe(409);
  expect(
    (await api.call('POST', '/auth/login', { email: account.email, password: 'mala-clave-123' }))
      .status,
  ).toBe(401);
  const login = await api.call('POST', '/auth/login', {
    email: account.email,
    password: account.password,
  });
  expect(login.status).toBe(200);
  expect(s((await api.call('GET', '/auth/session')).body)).toEqual(s(signup.body));

  const productRow = {
    id: 'string',
    name: 'string',
    created_at: 'string',
    category_id: 'string',
    category_name: 'string',
    brand_name: 'string',
    price_cents: 'string',
    available_units: 'string',
    rating: 'string',
    review_count: 'string',
    sold_units: 'string',
    views: 'string',
  };
  const list = await api.call('GET', '/store/products?limit=24');
  expect(list.status).toBe(200);
  expect(s({ ...list.body, elapsed_ms: 0 })).toEqual({
    data: [productRow],
    total: 'string',
    page: 'number',
    limit: 'number',
    elapsed_ms: 'number',
  });
  expect(list.body.total).toBe('60');
  const page3 = await api.call('GET', '/store/products?limit=24&page=3');
  expect(page3.body.data).toHaveLength(12);
  // Cursor (modo DynamoDB): mismas filas que la paginación por número.
  const c1 = await api.call('GET', '/store/products?limit=24&cursor=');
  const c2 = await api.call('GET', `/store/products?limit=24&cursor=${c1.body.next_cursor}`);
  const p2 = await api.call('GET', '/store/products?limit=24&page=2');
  expect(c2.body.data.map((p: { id: string }) => p.id)).toEqual(
    p2.body.data.map((p: { id: string }) => p.id),
  );
  for (const query of [
    'sort=price_asc',
    'sort=price_desc',
    'sort=newest',
    'sort=rating',
    'sort=trending',
    'category_id=1',
    'brand_id=2',
    'q=termo',
    'min_cents=2000&max_cents=4000',
    'in_stock=true',
    'min_rating=3',
  ]) {
    const r = await api.call('GET', `/store/products?${query}`);
    expect(r.status, query).toBe(200);
    expect(Number(r.body.total), query).toBeGreaterThan(0);
  }
  expect((await api.call('GET', '/store/products?category_id=1')).body.total).toBe('40'); // Cocina + Mates
  expect((await api.call('GET', '/store/products?sort=nope')).status).toBe(400);
  expect((await api.call('GET', '/store/products?foo=1')).status).toBe(400);

  const detail = await api.call('GET', '/store/products/1');
  expect(detail.status).toBe(200);
  expect(s(detail.body)).toEqual({
    data: {
      id: 'string',
      name: 'string',
      description: 'string',
      base_price_cents: 'string',
      category_id: 'string',
      category_name: 'string',
      brand_name: 'string',
      seller_name: 'string',
      variants: [
        {
          id: 'string',
          sku: 'string',
          color: 'string',
          size: 'string',
          price_cents: 'string',
          available_units: 'string',
        },
      ],
      reviews: [
        { id: 'string', rating: 'number', title: 'string', body: 'string', author: 'string' },
      ],
      related: [],
    },
  });
  expect((await api.call('GET', '/store/products/999999')).status).toBe(404);
  const filters = await api.call('GET', '/store/filters');
  expect(s(filters.body)).toEqual({
    categories: [{ id: 'string', name: 'string', parent_id: 'null', products: 'string' }],
    brands: [{ id: 'string', name: 'string', products: 'string' }],
  });

  const empty = await api.call('GET', '/cart');
  expect(empty.body).toEqual({ data: { version: 0, items: [], total_cents: '0' } });
  const variant = detail.body.data.variants[0].id;
  const cart = await api.call('PUT', '/cart', {
    version: 0,
    items: [{ variant_id: variant, quantity: 2 }],
  });
  expect(cart.status).toBe(200);
  expect(s(cart.body)).toEqual({
    data: {
      version: 'number',
      items: [
        {
          variant_id: 'string',
          product_id: 'string',
          color: 'string',
          size: 'string',
          price_cents: 'string',
          name: 'string',
          status: 'string',
          available: 'number',
          quantity: 'number',
        },
      ],
      total_cents: 'string',
    },
  });
  expect((await api.call('PUT', '/cart', { version: 0, items: [] })).status).toBe(409);
  expect(
    (
      await api.call('PUT', '/cart', {
        version: 1,
        items: [{ variant_id: variant, quantity: 999 }],
      })
    ).status,
  ).toBe(409);

  const address = await api.call('POST', '/store/customer/addresses', {
    street: 'Calle 1',
    city: 'CABA',
    country: 'AR',
    postal_code: '1000',
  });
  expect(address.status).toBe(201);
  expect(s(address.body)).toEqual({
    data: {
      id: 'string',
      street: 'string',
      city: 'string',
      country: 'string',
      postal_code: 'string',
    },
  });
  expect(
    (
      await api.call('POST', '/store/customer/addresses', {
        street: 'x',
        city: 'y',
        country: 'arg',
        postal_code: '1',
      })
    ).status,
  ).toBe(400);
  const customer = await api.call('GET', '/store/customer');
  expect(s(customer.body)).toEqual({
    data: { id: 'string', full_name: 'string', email: 'string', addresses: [s(address.body.data)] },
  });

  expect(
    (await api.call('POST', '/orders', { address_id: address.body.data.id, cart_version: 1 }))
      .status,
  ).toBe(400);
  const key = randomUUID();
  const order = await api.call(
    'POST',
    '/orders',
    { address_id: address.body.data.id, cart_version: 1 },
    { 'idempotency-key': key },
  );
  expect(order.status).toBe(201);
  const orderShape = {
    id: 'string',
    status: 'string',
    currency: 'string',
    total_cents: 'string',
    created_at: 'string',
    address_id: 'string',
    items: [
      {
        variant_id: 'string',
        product_name_snapshot: 'string',
        quantity: 'number',
        unit_price_cents: 'string',
      },
    ],
    status_history: [{ status: 'string', created_at: 'string' }],
    address: { street: 'string', city: 'string', country: 'string', postal_code: 'string' },
  };
  expect(s(order.body)).toEqual({ data: orderShape, replayed: 'boolean' });
  const replay = await api.call(
    'POST',
    '/orders',
    { address_id: address.body.data.id, cart_version: 1 },
    { 'idempotency-key': key },
  );
  expect(replay.status).toBe(200);
  expect(replay.body.data.id).toBe(order.body.data.id);

  const orders = await api.call('GET', '/orders');
  expect(s(orders.body)).toEqual({
    data: [
      {
        id: 'string',
        status: 'string',
        currency: 'string',
        total_cents: 'string',
        created_at: 'string',
      },
    ],
    next_before_id: 'null',
  });
  const one = await api.call('GET', `/orders/${order.body.data.id}`);
  expect(s(one.body)).toEqual({ data: orderShape });
  expect((await api.call('GET', '/orders/123456789')).status).toBe(404);

  expect((await api.call('POST', '/auth/logout')).status).toBe(200);
  expect((await api.call('GET', '/orders')).status).toBe(401);
});
