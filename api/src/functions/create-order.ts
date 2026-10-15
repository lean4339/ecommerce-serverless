import { createHash } from 'node:crypto';
import { HttpError, transaction } from '../db.js';
import { lambda, json, body, identifier, integer, type Operation } from '../shared/http.js';
import { readCart } from '../shared/cart.js';
import { orderView } from '../shared/orders.js';
import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  cancellationCodes,
  dynamo,
  getItem,
  nextIds,
  pad,
  tableName,
  useDynamo,
} from '../shared/dynamo.js';
import { orderViewDynamo, readCartDynamo, variantsInfo } from '../shared/dynamo-store.js';

const MAX_VARIANTS = 47; // 2 escrituras por variante + 6 fijas <= 100 por transacción
const IDEM_SECONDS = 24 * 60 * 60;

// DynamoDB: una sola TransactWriteItems descuenta stock (stock >= cantidad), crea el pedido
// (META, resumen, artículos, estado), vacía el carrito (version = :v) y guarda IDEM#<uuid>.
async function checkoutDynamo(
  customerId: string,
  addressId: string,
  version: number,
  key: string,
  fingerprint: string,
): Promise<{ orderId: string; replayed: boolean }> {
  const replay = async () => {
    const previous = await getItem(`IDEM#${key.toLowerCase()}`, 'IDEM');
    if (!previous) {
      return undefined;
    }
    if (String(previous.userId) !== customerId || previous.fingerprint !== fingerprint) {
      throw new HttpError(409, 'La clave de reintento pertenece a otro pedido');
    }
    return { orderId: String(previous.orderId), replayed: true };
  };
  const previous = await replay();
  if (previous) {
    return previous;
  }
  const cart = await readCartDynamo(customerId);
  if (cart.version !== version) {
    throw new HttpError(409, 'El carrito cambió. Volvé a revisarlo antes de confirmar');
  }
  if (!cart.items.length) {
    throw new HttpError(400, 'El carrito está vacío');
  }
  if (cart.items.length > MAX_VARIANTS) {
    throw new HttpError(400, `El pedido admite hasta ${MAX_VARIANTS} variantes`);
  }
  const [user, address] = await Promise.all([
    getItem(`USER#${customerId}`, 'PROFILE'),
    getItem(`USER#${customerId}`, `ADDR#${pad(addressId)}`),
  ]);
  if (!user || user.role !== 'customer') {
    throw new HttpError(404, 'Cliente inexistente');
  }
  if (!address) {
    throw new HttpError(400, 'La dirección no pertenece al cliente');
  }
  const variants = await variantsInfo(cart.items.map((i) => i.variant_id));
  let total = 0n;
  for (const item of cart.items) {
    const v = variants.get(item.variant_id);
    if (!v || v.status !== 'active' || v.stock < item.quantity) {
      throw new HttpError(409, `Stock insuficiente para variante ${item.variant_id}`);
    }
    total += BigInt(v.price_cents) * BigInt(item.quantity);
  }
  if (total > 9223372036854775807n) {
    throw new HttpError(400, 'El total excede el rango de la base');
  }
  const ids = await nextIds(cart.items.length + 2);
  const orderId = ids[0]!;
  const statusId = ids[1]!;
  const now = new Date();
  const createdAt = now.toISOString();
  const T = tableName();
  const order = {
    orderId,
    userId: customerId,
    status: 'created',
    currency: 'ARS',
    totalCents: total.toString(),
    createdAt,
  };
  const stockWrites = cart.items.map((item) => {
    const v = variants.get(item.variant_id)!;
    return {
      Update: {
        TableName: T,
        Key: { PK: `PRODUCT#${v.product_id}`, SK: `VARIANT#${pad(v.variant_id)}` },
        UpdateExpression: 'SET stock = stock - :q',
        ConditionExpression: 'stock >= :q',
        ExpressionAttributeValues: { ':q': item.quantity },
      },
    };
  });
  const transact = [
    ...stockWrites,
    {
      Put: {
        TableName: T,
        Item: {
          PK: `IDEM#${key.toLowerCase()}`,
          SK: 'IDEM',
          type: 'IDEM',
          userId: customerId,
          fingerprint,
          orderId,
          ttl: Math.floor(now.getTime() / 1000) + IDEM_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      Update: {
        TableName: T,
        Key: { PK: `USER#${customerId}`, SK: 'CART' },
        UpdateExpression: 'SET #items = :empty, version = version + :one, updatedAt = :now',
        ConditionExpression: 'version = :v',
        ExpressionAttributeNames: { '#items': 'items' },
        ExpressionAttributeValues: { ':empty': [], ':one': 1, ':now': createdAt, ':v': version },
      },
    },
    {
      Put: {
        TableName: T,
        Item: {
          PK: `ORDER#${orderId}`,
          SK: 'META',
          type: 'ORDER',
          ...order,
          addressId,
          customerEmail: user.email,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      Put: {
        TableName: T,
        Item: {
          PK: `USER#${customerId}`,
          SK: `ORDER#${createdAt}#${pad(orderId)}`,
          type: 'ORDER_SUMMARY',
          ...order,
        },
      },
    },
    {
      Put: {
        TableName: T,
        Item: {
          PK: `ORDER#${orderId}`,
          SK: `STATUS#${createdAt}#${pad(statusId)}`,
          type: 'ORDER_STATUS',
          status: 'created',
          createdAt,
        },
      },
    },
    ...cart.items.map((item, index) => {
      const v = variants.get(item.variant_id)!;
      const itemId = ids[index + 2]!;
      return {
        Put: {
          TableName: T,
          Item: {
            PK: `ORDER#${orderId}`,
            SK: `ITEM#${pad(itemId)}`,
            type: 'ORDER_ITEM',
            orderItemId: itemId,
            variantId: v.variant_id,
            productName: v.name,
            quantity: item.quantity,
            unitPriceCents: v.price_cents,
          },
        },
      };
    }),
  ];
  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transact }));
  } catch (error) {
    const codes = cancellationCodes(error);
    if (!codes) {
      throw error;
    }
    const n = stockWrites.length;
    if (codes[n] === 'ConditionalCheckFailed') {
      // Otro reintento con la misma clave confirmó primero.
      const winner = await replay();
      if (winner) {
        return winner;
      }
    }
    const failedStock = codes.slice(0, n).findIndex((c) => c === 'ConditionalCheckFailed');
    if (failedStock >= 0) {
      throw new HttpError(
        409,
        `Stock insuficiente para variante ${cart.items[failedStock]!.variant_id}`,
      );
    }
    if (codes[n + 1] === 'ConditionalCheckFailed') {
      throw new HttpError(409, 'El carrito cambió. Volvé a revisarlo antes de confirmar');
    }
    if (codes.includes('TransactionConflict')) {
      throw new HttpError(409, 'Otro pedido está usando el mismo stock. Intentá de nuevo');
    }
    throw error;
  }
  // Métrica de catálogo (no transaccional): unidades disponibles del producto para el listado.
  const perProduct = new Map<string, number>();
  for (const item of cart.items) {
    const productId = variants.get(item.variant_id)!.product_id;
    perProduct.set(productId, (perProduct.get(productId) ?? 0) + item.quantity);
  }
  await Promise.allSettled(
    [...perProduct].map(([productId, quantity]) =>
      dynamo.send(
        new UpdateCommand({
          TableName: T,
          Key: { PK: `PRODUCT#${productId}`, SK: 'META' },
          UpdateExpression: 'ADD availableUnits :neg',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':neg': -quantity },
        }),
      ),
    ),
  );
  return { orderId, replayed: false };
}

// Confirmar pedido: guardar la compra, reservar stock y vaciar el carrito.
// PostgreSQL confirma todos esos cambios juntos; si alguno falla, deshace todo.
export const execute: Operation = async (event, { pool, customerId, log }) => {
  const input = body(event, ['address_id', 'cart_version']);
  const addressId = identifier(input.address_id);
  const version = integer(input.cart_version, 0, 2147483646);
  const key = Object.entries(event.headers).find(
    ([name]) => name.toLowerCase() === 'idempotency-key',
  )?.[1];
  if (
    !key ||
    !/^\w{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(key) ||
    !/^[\da-f-]+$/i.test(key)
  ) {
    throw new HttpError(400, 'Se requiere Idempotency-Key UUID v4');
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ addressId, version }))
    .digest('hex');
  const result = useDynamo()
    ? await checkoutDynamo(customerId, addressId, version, key, fingerprint)
    : await transaction(pool, async (db) => {
        // Serializa cambios de este carrito, no todos los compradores.
        const cart = await readCart(db, customerId, true);
        const previous = await db.query(
          'SELECT order_id,fingerprint FROM store_checkouts WHERE user_id=$1 AND request_key=$2',
          [customerId, key],
        );
        if (previous.rows[0]) {
          if (previous.rows[0].fingerprint !== fingerprint) {
            throw new HttpError(409, 'La clave de reintento pertenece a otro pedido');
          }
          return { orderId: previous.rows[0].order_id as string, replayed: true };
        }
        if (cart.version !== version) {
          throw new HttpError(409, 'El carrito cambió. Volvé a revisarlo antes de confirmar');
        }
        if (!cart.items.length) {
          throw new HttpError(400, 'El carrito está vacío');
        }
        const user = await db.query("SELECT email FROM users WHERE id=$1 AND role='customer'", [
          customerId,
        ]);
        if (!user.rows[0]) {
          throw new HttpError(404, 'Cliente inexistente');
        }
        const address = await db.query('SELECT id FROM addresses WHERE id=$1 AND user_id=$2', [
          addressId,
          customerId,
        ]);
        if (!address.rowCount) {
          throw new HttpError(400, 'La dirección no pertenece al cliente');
        }
        // Orden estable de bloqueo: dos compradores no reservan la misma última unidad.
        const stock = await db.query<{
          id: string;
          variant_id: string;
          quantity: number;
          reserved: number;
          price_cents: string;
          name: string;
        }>(
          `
      SELECT inv.id,inv.variant_id,inv.quantity,inv.reserved,v.price_cents,p.name
      FROM inventory inv JOIN product_variants v ON v.id=inv.variant_id JOIN products p ON p.id=v.product_id
      WHERE v.id=ANY($1::bigint[]) AND p.status='active' ORDER BY inv.id FOR UPDATE OF inv`,
          [cart.items.map((i) => i.variant_id)],
        );
        let total = 0n;
        const snapshots: { variant_id: string; quantity: number; price: string; name: string }[] =
          [];
        for (const item of cart.items) {
          const inventories = stock.rows.filter((s) => s.variant_id === item.variant_id);
          const first = inventories[0];
          if (
            !first ||
            inventories.reduce((sum, i) => sum + Math.max(0, i.quantity - i.reserved), 0) <
              item.quantity
          ) {
            throw new HttpError(409, `Stock insuficiente para variante ${item.variant_id}`);
          }
          let remaining = item.quantity;
          for (const inv of inventories) {
            const reserve = Math.min(remaining, Math.max(0, inv.quantity - inv.reserved));
            if (reserve > 0) {
              await db.query(
                'UPDATE inventory SET reserved=reserved+$1,updated_at=now() WHERE id=$2',
                [reserve, inv.id],
              );
            }
            remaining -= reserve;
            if (remaining === 0) {
              break;
            }
          }
          total += BigInt(first.price_cents) * BigInt(item.quantity);
          snapshots.push({ ...item, price: first.price_cents, name: first.name });
        }
        if (total > 9223372036854775807n) {
          throw new HttpError(400, 'El total excede el rango de la base');
        }
        const order = await db.query(
          `INSERT INTO orders
      (id,user_id,address_id,coupon_id,status,currency,total_cents,customer_email_snapshot,created_at,metadata_text)
      VALUES(nextval('api_entity_id_seq'),$1,$2,NULL,'created','ARS',$3,$4,now(),'{}') RETURNING id`,
          [customerId, addressId, total.toString(), user.rows[0].email],
        );
        const orderId = order.rows[0].id as string;
        for (const item of snapshots) {
          await db.query(
            `INSERT INTO order_items
      (id,order_id,variant_id,product_name_snapshot,quantity,unit_price_cents)
      VALUES(nextval('api_entity_id_seq'),$1,$2,$3,$4,$5)`,
            [orderId, item.variant_id, item.name, item.quantity, item.price],
          );
        }
        await db.query(
          "INSERT INTO order_status_history VALUES(nextval('api_entity_id_seq'),$1,'created',now())",
          [orderId],
        );
        await db.query(
          "UPDATE store_carts SET items='[]',version=version+1,updated_at=now() WHERE user_id=$1",
          [customerId],
        );
        await db.query(
          'INSERT INTO store_checkouts(user_id,request_key,fingerprint,order_id) VALUES($1,$2,$3,$4)',
          [customerId, key, fingerprint, orderId],
        );
        return { orderId, replayed: false };
      });
  log({ event: result.replayed ? 'order.replayed' : 'order.created', orderId: result.orderId });
  return {
    ...json(
      {
        data: useDynamo()
          ? await orderViewDynamo(result.orderId, customerId)
          : await orderView(pool, result.orderId, customerId),
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201,
    ),
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      location: `/api/v1/orders/${result.orderId}`,
    },
  };
};
export const handler = lambda('create-order', execute);
