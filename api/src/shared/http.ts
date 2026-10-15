import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import type pg from 'pg';
import { HttpError, id } from '../db.js';
import { createRuntimePool } from './database.js';
import { requireSession, requireSessionDynamo, requireTrustedOrigin } from './sessions.js';
import { useDynamo } from './dynamo.js';

export type Event = APIGatewayProxyEventV2;
export type Result = APIGatewayProxyStructuredResultV2 & { statusCode: number; body: string };
export type Log = (record: Record<string, unknown>) => void;
export type Dependencies = { pool: pg.Pool; customerId: string; log: Log };
export type Operation = (event: Event, deps: Dependencies) => Promise<Result>;
export const json = (data: unknown, statusCode = 200): Result => ({
  statusCode,
  body: JSON.stringify(data),
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// Cada archivo functions/*.ts crea SU handler y SU pool fuera de la invocación.
// Compartir esta librería no convierte las funciones en un único proceso.
export function lambda(
  name: string,
  operation: Operation,
  options: {
    pool?: pg.Pool;
    customerId?: string;
    log?: Log;
    authentication?: 'required' | 'public';
  } = {},
) {
  let pool = options.pool;
  let openingPool: Promise<pg.Pool> | undefined;
  let coldStart = true;
  const output: Log =
    options.log ??
    ((record) => {
      const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record });
      if (record.level === 'ERROR') {
        console.error(line);
      } else {
        console.info(line);
      }
    });
  return async (event: Event, context: Context): Promise<Result> => {
    context.callbackWaitsForEmptyEventLoop = false;
    const started = performance.now();
    const requestId = context.awsRequestId;
    const log: Log = (record) =>
      output({
        level: 'INFO',
        ...record,
        function: name,
        requestId,
        gatewayRequestId: event?.requestContext?.requestId,
      });
    log({ event: 'request.start', coldStart, method: event?.requestContext?.http?.method });
    coldStart = false;
    let response: Result;
    try {
      if (event?.version !== '2.0' || !event.requestContext?.http) {
        throw new HttpError(400, 'Se requiere un evento API Gateway HTTP v2');
      }
      if (event.body && Buffer.byteLength(event.body) > 64 * 1024) {
        throw new HttpError(413, 'Solicitud demasiado grande');
      }
      requireTrustedOrigin(event);
      const dynamoMode = useDynamo();
      if (!pool && !dynamoMode) {
        openingPool ??= createRuntimePool().catch((error: unknown) => {
          openingPool = undefined;
          throw error;
        });
        pool = await openingPool;
      }
      // customerId solo se inyecta en tests. En los handlers reales viene de la sesión.
      const customerId = options.customerId
        ? id(options.customerId)
        : options.authentication === 'public'
          ? ''
          : dynamoMode
            ? (await requireSessionDynamo(event)).id
            : (await requireSession(pool!, event)).id;
      // En modo DynamoDB no se abre el pool de PostgreSQL (ni el túnel SSH).
      response = await operation(event, { pool: pool as pg.Pool, customerId, log });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const transient = [
        '57014',
        '55P03',
        '53300',
        '57P03',
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'ProvisionedThroughputExceededException',
        'ThrottlingException',
        'RequestLimitExceeded',
        'InternalServerError',
      ].includes(code ?? (error as { name?: string }).name ?? '');
      const status = error instanceof HttpError ? error.statusCode : transient ? 503 : 500;
      // No registrar cuerpo, email, dirección, cadena de conexión ni errores SQL con datos.
      log({
        level: status >= 500 ? 'ERROR' : 'WARN',
        event: 'request.error',
        statusCode: status,
        errorType: error instanceof Error ? error.name : 'Error',
        code,
      });
      response = json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : status === 503
                ? 'Base temporalmente no disponible'
                : 'No pudimos completar la operación',
          request_id: requestId,
        },
        status,
      );
      if (status === 429) {
        response.headers = { ...response.headers, 'retry-after': '900' };
      }
    }
    log({
      event: 'request.complete',
      statusCode: response.statusCode,
      durationMs: Math.round(performance.now() - started),
    });
    return {
      ...response,
      headers: { ...response.headers, 'x-request-id': requestId, 'x-lambda-function': name },
    };
  };
}

export function body(event: Event, allowed: string[]): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(
      event.isBase64Encoded
        ? Buffer.from(event.body ?? '', 'base64').toString()
        : (event.body ?? ''),
    );
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Se requiere un objeto JSON');
  }
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, 'Campo no permitido');
  }
  return obj;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'El ID debe ser una cadena');
  }
  return id(value);
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'Cantidad o versión fuera de rango');
  }
  return value;
}
