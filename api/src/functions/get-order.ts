import { lambda, json, identifier, type Operation } from '../shared/http.js';
import { orderView } from '../shared/orders.js';
import { useDynamo } from '../shared/dynamo.js';
import { orderViewDynamo } from '../shared/dynamo-store.js';
export const execute: Operation = async (event, { pool, customerId }) => {
  const orderId = identifier(event.pathParameters?.id);
  return json({
    data: useDynamo()
      ? await orderViewDynamo(orderId, customerId)
      : await orderView(pool, orderId, customerId),
  });
};
export const handler = lambda('get-order', execute);
