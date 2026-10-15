import { lambda, json, type Operation } from '../shared/http.js';
import { readCart, cartView } from '../shared/cart.js';
import { useDynamo } from '../shared/dynamo.js';
import { cartViewDynamo, readCartDynamo } from '../shared/dynamo-store.js';
export const execute: Operation = async (_event, { pool, customerId }) =>
  json({
    data: useDynamo()
      ? await cartViewDynamo(await readCartDynamo(customerId))
      : await cartView(pool, await readCart(pool, customerId)),
  });
export const handler = lambda('get-cart', execute);
