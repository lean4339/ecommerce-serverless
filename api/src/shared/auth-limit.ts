import type pg from 'pg';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError } from '../db.js';
import { dynamo, isConditionFailure, tableName, useDynamo } from './dynamo.js';
import { tokenHash } from './sessions.js';

// Estado en PostgreSQL: el límite sigue funcionando entre distintas instancias Lambda.
const WINDOW_SECONDS = 15 * 60;
// DynamoDB: RATE#<sha256 del bucket> con contador atómico y ttl de 15 minutos.
async function attemptDynamo(bucketKey: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const Key = { PK: `RATE#${bucketKey}`, SK: 'RATE' };
  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: tableName(),
        Key,
        UpdateExpression: 'ADD attempts :one',
        ConditionExpression: 'windowStart > :cutoff',
        ExpressionAttributeValues: { ':one': 1, ':cutoff': now - WINDOW_SECONDS },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return Number(result.Attributes!.attempts);
  } catch (error) {
    if (!isConditionFailure(error)) {
      throw error;
    }
    // Ventana nueva (o vencida): reiniciar a 1. Una carrera aquí solo puede reiniciar de más una vez.
    await dynamo.send(
      new PutCommand({
        TableName: tableName(),
        Item: { ...Key, type: 'RATE', attempts: 1, windowStart: now, ttl: now + WINDOW_SECONDS },
      }),
    );
    return 1;
  }
}

export async function limitAuth(pool: pg.Pool, action: string, email: string, ip: string) {
  const buckets = [
    { key: `${action}:ip:${ip}`, maximum: 60 },
    { key: `${action}:email:${email}`, maximum: 10 },
  ];
  for (const bucket of buckets) {
    if (useDynamo()) {
      if ((await attemptDynamo(tokenHash(bucket.key))) > bucket.maximum) {
        throw new HttpError(429, 'Demasiados intentos. Probá nuevamente en unos minutos');
      }
      continue;
    }
    const result = await pool.query<{ attempts: number }>(
      `
      INSERT INTO store_auth_limits(bucket_key,attempts) VALUES($1,1)
      ON CONFLICT(bucket_key) DO UPDATE SET
        attempts=CASE WHEN store_auth_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE store_auth_limits.attempts+1 END,
        window_start=CASE WHEN store_auth_limits.window_start<now()-interval '15 minutes' THEN now() ELSE store_auth_limits.window_start END
      RETURNING attempts`,
      [tokenHash(bucket.key)],
    );
    if (result.rows[0]!.attempts > bucket.maximum) {
      throw new HttpError(429, 'Demasiados intentos. Probá nuevamente en unos minutos');
    }
  }
}
