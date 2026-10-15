import type pg from 'pg';
import { HttpError } from '../db.js';
export async function orderView(db: Pick<pg.Pool, 'query'>, orderId: string, customerId: string) {
  const result = await db.query(
    `SELECT id,status,currency,total_cents,created_at,address_id
    FROM orders WHERE id=$1 AND user_id=$2`,
    [orderId, customerId],
  );
  if (!result.rows[0]) {
    throw new HttpError(404, 'Pedido inexistente');
  }
  const [items, history, address] = await Promise.all([
    db.query(
      'SELECT variant_id,product_name_snapshot,quantity,unit_price_cents FROM order_items WHERE order_id=$1 ORDER BY id',
      [orderId],
    ),
    db.query(
      'SELECT status,created_at FROM order_status_history WHERE order_id=$1 ORDER BY created_at,id',
      [orderId],
    ),
    db.query('SELECT street,city,country,postal_code FROM addresses WHERE id=$1 AND user_id=$2', [
      result.rows[0].address_id,
      customerId,
    ]),
  ]);
  return {
    ...result.rows[0],
    items: items.rows,
    status_history: history.rows,
    address: address.rows[0],
  };
}
