import type pg from 'pg';
import { HttpError } from '../db.js';
import { identifier, integer } from './http.js';

export type Item = { variant_id: string; quantity: number };
export type Cart = { version: number; items: Item[] };
type Queryable = Pick<pg.Pool, 'query'>;
export function items(value: unknown): Item[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new HttpError(400, 'El carrito admite hasta 50 variantes');
  }
  const result = value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Object.keys(item).some((key) => !['variant_id', 'quantity'].includes(key))
    ) {
      throw new HttpError(400, 'Artículo inválido');
    }
    return { variant_id: identifier(item.variant_id), quantity: integer(item.quantity, 1, 1000) };
  });
  if (new Set(result.map((i) => i.variant_id)).size !== result.length) {
    throw new HttpError(400, 'No repitas variantes');
  }
  return result;
}
export async function readCart(db: Queryable, customerId: string, lock = false): Promise<Cart> {
  if (lock) {
    await db.query('INSERT INTO store_carts(user_id) VALUES($1) ON CONFLICT DO NOTHING', [
      customerId,
    ]);
  }
  const result = await db.query<Cart>(
    `SELECT version,items FROM store_carts WHERE user_id=$1${lock ? ' FOR UPDATE' : ''}`,
    [customerId],
  );
  return result.rows[0] ?? { version: 0, items: [] };
}
export async function cartView(db: Queryable, cart: Cart) {
  if (!cart.items.length) {
    return { ...cart, total_cents: '0' };
  }
  const result = await db.query(
    `SELECT v.id AS variant_id,v.product_id,v.color,v.size,v.price_cents,p.name,p.status,
    coalesce(sum(greatest(i.quantity-i.reserved,0)),0)::text AS available
    FROM product_variants v JOIN products p ON p.id=v.product_id LEFT JOIN inventory i ON i.variant_id=v.id
    WHERE v.id=ANY($1::bigint[]) GROUP BY v.id,p.id`,
    [cart.items.map((i) => i.variant_id)],
  );
  let total = 0n;
  const resolved = cart.items.map((item) => {
    const variant = result.rows.find((v) => v.variant_id === item.variant_id);
    if (!variant) {
      throw new HttpError(409, 'Un artículo del carrito ya no existe');
    }
    total += BigInt(variant.price_cents) * BigInt(item.quantity);
    return {
      ...variant,
      quantity: item.quantity,
      available: variant.status === 'active' ? Number(variant.available) : 0,
    };
  });
  return { version: cart.version, items: resolved, total_cents: total.toString() };
}
