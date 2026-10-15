import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError } from '../db.js';
import { lambda, json, identifier, type Operation } from '../shared/http.js';
import { dynamo, tableName, useDynamo } from '../shared/dynamo.js';

const PAGE = 20;

const fromPostgres: Operation = async (event, { pool, customerId }) => {
  const before = event.queryStringParameters?.before_id;
  const result = await pool.query(
    `SELECT id,status,currency,total_cents,created_at FROM orders
    WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 21`,
    [customerId, before ? identifier(before) : null],
  );
  const data = result.rows.slice(0, PAGE);
  return json({ data, next_before_id: result.rows.length > PAGE ? data.at(-1)!.id : null });
};

// En Dynamo, before_id / next_before_id es un cursor opaco (LastEvaluatedKey en base64url).
const pk = (customerId: string) => `USER#${customerId}`;
function decodeCursor(value: string, customerId: string): Record<string, string> {
  try {
    const key = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (key.PK === pk(customerId) && typeof key.SK === 'string' && key.SK.startsWith('ORDER#')) {
      return { PK: key.PK, SK: key.SK };
    }
  } catch {
    // cae al error de abajo
  }
  throw new HttpError(400, 'Cursor inválido');
}

const fromDynamo: Operation = async (event, { customerId }) => {
  const before = event.queryStringParameters?.before_id;
  const result = await dynamo.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk(customerId), ':prefix': 'ORDER#' },
      ScanIndexForward: false,
      Limit: PAGE,
      ExclusiveStartKey: before ? decodeCursor(before, customerId) : undefined,
    }),
  );
  // Mismo formato que Postgres: bigint como string y fechas ISO.
  const data = (result.Items ?? []).map((item) => ({
    id: String(item.orderId),
    status: item.status,
    currency: item.currency,
    total_cents: String(item.totalCents),
    created_at: item.createdAt,
  }));
  const last = result.LastEvaluatedKey;
  return json({
    data,
    next_before_id: last
      ? Buffer.from(JSON.stringify({ PK: last.PK, SK: last.SK })).toString('base64url')
      : null,
  });
};

export const execute: Operation = (event, deps) =>
  useDynamo() ? fromDynamo(event, deps) : fromPostgres(event, deps);
export const handler = lambda('list-orders', execute);
