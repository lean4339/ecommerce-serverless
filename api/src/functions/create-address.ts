import { HttpError, transaction } from '../db.js';
import { body, json, lambda, type Operation } from '../shared/http.js';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, nextIds, pad, queryAll, tableName, useDynamo } from '../shared/dynamo.js';

// El comprador recién registrado puede cargar su dirección al confirmar la compra.
export const execute: Operation = async (event, { pool, customerId }) => {
  const input = body(event, ['street', 'city', 'country', 'postal_code']);
  const fields: Record<string, string> = {};
  for (const [key, maximum] of Object.entries({
    street: 200,
    city: 100,
    country: 2,
    postal_code: 20,
  })) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
      throw new HttpError(400, `Campo de dirección inválido: ${key}`);
    }
    fields[key] = value.trim();
  }
  if (!/^[A-Z]{2}$/.test(fields.country!)) {
    throw new HttpError(400, 'El país debe tener dos letras mayúsculas, por ejemplo AR');
  }
  if (useDynamo()) {
    const existing = await queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :addr)',
      ExpressionAttributeValues: { ':pk': `USER#${customerId}`, ':addr': 'ADDR#' },
      ProjectionExpression: 'SK',
      ConsistentRead: true,
    });
    if (existing.length >= 20) {
      throw new HttpError(400, 'Ya tenés 20 direcciones guardadas');
    }
    const [id] = await nextIds(1);
    await dynamo.send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          PK: `USER#${customerId}`,
          SK: `ADDR#${pad(id!)}`,
          type: 'ADDRESS',
          addressId: id,
          street: fields.street,
          city: fields.city,
          country: fields.country,
          postalCode: fields.postal_code,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return json(
      {
        data: {
          id,
          street: fields.street,
          city: fields.city,
          country: fields.country,
          postal_code: fields.postal_code,
        },
      },
      201,
    );
  }
  const address = await transaction(pool, async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [customerId]);
    const count = await db.query('SELECT count(*)::integer AS n FROM addresses WHERE user_id=$1', [
      customerId,
    ]);
    if (count.rows[0].n >= 20) {
      throw new HttpError(400, 'Ya tenés 20 direcciones guardadas');
    }
    const result = await db.query(
      `INSERT INTO addresses(id,user_id,street,city,country,postal_code)
      VALUES(nextval('api_entity_id_seq'),$1,$2,$3,$4,$5) RETURNING id,street,city,country,postal_code`,
      [customerId, fields.street, fields.city, fields.country, fields.postal_code],
    );
    return result.rows[0];
  });
  return json({ data: address }, 201);
};
export const handler = lambda('create-address', execute);
