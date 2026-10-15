import { HttpError } from '../db.js';
import { lambda, json, type Operation } from '../shared/http.js';
import { getItem, queryAll, str, useDynamo } from '../shared/dynamo.js';
import { addressView } from '../shared/dynamo-store.js';
export const execute: Operation = async (_event, { pool, customerId }) => {
  if (useDynamo()) {
    const [profile, addresses] = await Promise.all([
      getItem(`USER#${customerId}`, 'PROFILE'),
      queryAll({
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :addr)',
        ExpressionAttributeValues: { ':pk': `USER#${customerId}`, ':addr': 'ADDR#' },
        ConsistentRead: true,
      }),
    ]);
    if (!profile || profile.role !== 'customer') {
      throw new HttpError(404, 'Cliente inexistente');
    }
    return json({
      data: {
        id: String(profile.userId),
        full_name: str(profile.fullName),
        email: str(profile.email),
        addresses: addresses.slice(0, 100).map(addressView),
      },
    });
  }

  const customer = await pool.query(
    "SELECT id,full_name,email FROM users WHERE id=$1 AND role='customer'",
    [customerId],
  );
  if (!customer.rows[0]) {
    throw new HttpError(404, 'Cliente inexistente');
  }
  const addresses = await pool.query(
    'SELECT id,street,city,country,postal_code FROM addresses WHERE user_id=$1 ORDER BY id LIMIT 100',
    [customerId],
  );
  return json({ data: { ...customer.rows[0], addresses: addresses.rows } });
};
export const handler = lambda('get-customer', execute);
