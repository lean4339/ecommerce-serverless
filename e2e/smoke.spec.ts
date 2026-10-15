// Smoke post-deploy contra producción (@smoke). Mínimo de datos: 1 cuenta desechable,
// 1 dirección y 1 pedido de 1 unidad. ~1 req/s (API Gateway: 2 req/s, ráfaga 5).
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Api, newAccount } from './helpers';

test('@smoke tienda en vivo: UI carga y flujo de compra por API', async ({
  page,
  request,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Iniciá sesión' })).toBeVisible();

  const api = new Api(request, origin);
  const account = newAccount();
  expect((await api.call('POST', '/auth/signup', account)).status).toBe(201);
  const list = await api.call('GET', '/store/products?in_stock=true&limit=5');
  expect(list.status).toBe(200);
  expect(Number(list.body.total)).toBeGreaterThan(0);
  expect((await api.call('GET', '/store/filters')).status).toBe(200);
  const product = await api.call('GET', `/store/products/${list.body.data[0].id}`);
  const variant = product.body.data.variants.find(
    (v: { available_units: string }) => Number(v.available_units) > 0,
  );
  expect(variant).toBeTruthy();
  const cart = await api.call('PUT', '/cart', {
    version: 0,
    items: [{ variant_id: variant.id, quantity: 1 }],
  });
  expect(cart.status).toBe(200);
  const address = await api.call('POST', '/store/customer/addresses', {
    street: 'Smoke 1',
    city: 'CABA',
    country: 'AR',
    postal_code: '1000',
  });
  expect(address.status).toBe(201);
  const order = await api.call(
    'POST',
    '/orders',
    { address_id: address.body.data.id, cart_version: cart.body.data.version },
    { 'idempotency-key': randomUUID() },
  );
  expect(order.status).toBe(201);
  const orders = await api.call('GET', '/orders');
  expect(orders.body.data[0].id).toBe(order.body.data.id);
  expect((await api.call('GET', `/orders/${order.body.data.id}`)).status).toBe(200);
  expect((await api.call('POST', '/auth/logout')).status).toBe(200);
  expect((await api.call('GET', '/orders')).status).toBe(401);
});
