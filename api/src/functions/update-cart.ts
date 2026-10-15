import { HttpError, transaction } from '../db.js';
import { lambda, json, body, integer, type Operation } from '../shared/http.js';
import { readCart, cartView, items } from '../shared/cart.js';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, isConditionFailure, tableName, useDynamo } from '../shared/dynamo.js';
import { cartViewDynamo, readCartDynamo } from '../shared/dynamo-store.js';

const changed = () => new HttpError(409, 'El carrito cambió. Recargalo e intentá de nuevo');
// DynamoDB: control optimista con la condición version = :v (o carrito inexistente en versión 0).
async function updateDynamo(
  customerId: string,
  version: number,
  requested: ReturnType<typeof items>,
) {
  const cart = await readCartDynamo(customerId);
  if (cart.version !== version) {
    throw changed();
  }
  const next = await cartViewDynamo({ version: version + 1, items: requested });
  if (next.items.some((item) => 'available' in item && Number(item.available) < item.quantity)) {
    throw new HttpError(409, 'Stock insuficiente en el carrito');
  }
  try {
    await dynamo.send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          PK: `USER#${customerId}`,
          SK: 'CART',
          type: 'CART',
          version: version + 1,
          items: requested,
          updatedAt: new Date().toISOString(),
        },
        ConditionExpression:
          version === 0 ? 'attribute_not_exists(PK) OR version = :v' : 'version = :v',
        ExpressionAttributeValues: { ':v': version },
      }),
    );
  } catch (error) {
    throw isConditionFailure(error) ? changed() : error;
  }
  return next;
}
export const execute: Operation = async (event, { pool, customerId, log }) => {
  const input = body(event, ['version', 'items']);
  const version = integer(input.version, 0, 2147483646);
  const requested = items(input.items);
  const result = useDynamo()
    ? await updateDynamo(customerId, version, requested)
    : await transaction(pool, async (db) => {
        const cart = await readCart(db, customerId, true);
        if (cart.version !== version) {
          throw new HttpError(409, 'El carrito cambió. Recargalo e intentá de nuevo');
        }
        const next = await cartView(db, { version: version + 1, items: requested });
        if (
          next.items.some((item) => 'available' in item && Number(item.available) < item.quantity)
        ) {
          throw new HttpError(409, 'Stock insuficiente en el carrito');
        }
        await db.query(
          'UPDATE store_carts SET items=$1::jsonb,version=version+1,updated_at=now() WHERE user_id=$2',
          [JSON.stringify(requested), customerId],
        );
        return next;
      });
  log({ event: 'cart.updated', version: result.version, itemCount: requested.length });
  return json({ data: result });
};
export const handler = lambda('update-cart', execute);
