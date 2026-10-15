import pg, { type PoolClient } from 'pg';
export function createPool(connectionString = process.env.DATABASE_URL, connectionTimeout = 5000) {
  if (!connectionString) {
    throw new Error('Falta DATABASE_URL');
  }
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: connectionTimeout,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    lock_timeout: 5000,
    application_name: process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'nexo-local',
  });
  pool.on('error', () =>
    console.error(JSON.stringify({ level: 'ERROR', event: 'db.idle_connection_error' })),
  );
  return pool;
}
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function id(value: string, allowZero = false): string {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new HttpError(400, 'ID inválido');
  }
  const n = BigInt(value);
  if (n > 9223372036854775807n || (!allowZero && n === 0n)) {
    throw new HttpError(400, 'ID fuera de rango');
  }
  return value;
}
export async function transaction<T>(
  pool: pg.Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
