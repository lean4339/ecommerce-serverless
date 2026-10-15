import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError } from '../db.js';
import { dynamo, getItem, tableName } from './dynamo.js';
import type { Event } from './http.js';

type Database = Pick<pg.Pool, 'query'>;
export type SessionUser = { id: string; full_name: string; email: string };
const SESSION_SECONDS = 8 * 60 * 60;
export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

function settings() {
  const value = process.env.APP_ORIGIN;
  if (!value) {
    throw new Error('Falta APP_ORIGIN');
  }
  const origin = new URL(value);
  if (origin.origin !== value || origin.username || origin.password) {
    throw new Error('APP_ORIGIN debe ser un origen sin ruta');
  }
  const local =
    process.env.LOCAL_DEVELOPMENT === 'true' &&
    !process.env.AWS_LAMBDA_FUNCTION_NAME &&
    origin.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(origin.hostname);
  if (!local && origin.protocol !== 'https:') {
    throw new Error('La aplicación requiere HTTPS');
  }
  return {
    origin: value,
    secure: !local,
    cookieName: local ? 'nexo_session' : '__Host-nexo_session',
  };
}

export function requireTrustedOrigin(event: Event) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(event.requestContext.http.method)) {
    return;
  }
  const origin = Object.entries(event.headers).find(
    ([name]) => name.toLowerCase() === 'origin',
  )?.[1];
  if (origin !== settings().origin) {
    throw new HttpError(403, 'Origen no permitido');
  }
}

export function sessionToken(event: Event): string | undefined {
  const name = settings().cookieName;
  const header = Object.entries(event.headers).find(([key]) => key.toLowerCase() === 'cookie')?.[1];
  const cookies = event.cookies ?? (header ? [header] : []);
  const matches = cookies
    .flatMap((line) => line.split(';'))
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) {
    return undefined;
  }
  const token = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function sessionCookie(token: string, clear = false): string {
  const { cookieName, secure } = settings();
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

export async function requireSession(db: Database, event: Event): Promise<SessionUser> {
  const token = sessionToken(event);
  if (!token) {
    throw new HttpError(401, 'Iniciá sesión para continuar');
  }
  const result = await db.query<SessionUser>(
    `
    SELECT u.id,u.full_name,a.email
    FROM store_sessions s JOIN store_accounts a ON a.user_id=s.user_id JOIN users u ON u.id=a.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND u.role='customer'`,
    [tokenHash(token)],
  );
  if (!result.rows[0]) {
    throw new HttpError(401, 'Tu sesión venció. Volvé a ingresar');
  }
  return result.rows[0];
}

export async function revokeSession(db: Database, event: Event) {
  const token = sessionToken(event);
  if (token) {
    await db.query('DELETE FROM store_sessions WHERE token_hash=$1', [tokenHash(token)]);
  }
}

export async function issueSession(db: Database, event: Event, userId: string): Promise<string> {
  await revokeSession(db, event);
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO store_sessions(token_hash,user_id,expires_at)
    VALUES($1,$2,now()+$3::integer*interval '1 second')`,
    [tokenHash(token), userId, SESSION_SECONDS],
  );
  return sessionCookie(token);
}

// --- DynamoDB: SESSION#<sha256 del token>, con ttl para que DynamoDB las borre al vencer.
export async function requireSessionDynamo(event: Event): Promise<SessionUser> {
  const token = sessionToken(event);
  if (!token) {
    throw new HttpError(401, 'Iniciá sesión para continuar');
  }
  const session = await getItem(`SESSION#${tokenHash(token)}`, 'SESSION');
  const now = Math.floor(Date.now() / 1000);
  const profile =
    session && Number(session.expiresAt) > now
      ? await getItem(`USER#${String(session.userId)}`, 'PROFILE')
      : undefined;
  if (!profile || profile.role !== 'customer') {
    throw new HttpError(401, 'Tu sesión venció. Volvé a ingresar');
  }
  return {
    id: String(profile.userId),
    full_name: String(profile.fullName),
    email: String(profile.email).toLowerCase(),
  };
}

export async function revokeSessionDynamo(event: Event) {
  const token = sessionToken(event);
  if (token) {
    await dynamo.send(
      new DeleteCommand({
        TableName: tableName(),
        Key: { PK: `SESSION#${tokenHash(token)}`, SK: 'SESSION' },
      }),
    );
  }
}

export function sessionItem(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return {
    token,
    item: {
      PK: `SESSION#${tokenHash(token)}`,
      SK: 'SESSION',
      type: 'SESSION',
      userId,
      expiresAt,
      ttl: expiresAt,
    },
  };
}

export async function issueSessionDynamo(event: Event, userId: string): Promise<string> {
  await revokeSessionDynamo(event);
  const { token, item } = sessionItem(userId);
  await dynamo.send(new PutCommand({ TableName: tableName(), Item: item }));
  return sessionCookie(token);
}
