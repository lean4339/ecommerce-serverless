import { HttpError, transaction } from '../db.js';
import { body, json, lambda, type Operation } from '../shared/http.js';
import { hashPassword, passwordInput, verifyPassword } from '../shared/passwords.js';
import {
  issueSession,
  requireSession,
  revokeSession,
  sessionCookie,
  type SessionUser,
} from '../shared/sessions.js';
import { limitAuth } from '../shared/auth-limit.js';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  batchGet,
  cancellationCodes,
  dynamo,
  getItem,
  nextIds,
  tableName,
  useDynamo,
} from '../shared/dynamo.js';
import {
  issueSessionDynamo,
  requireSessionDynamo,
  revokeSessionDynamo,
  sessionItem,
} from '../shared/sessions.js';

const duplicate = () =>
  new HttpError(409, 'No se pudo registrar ese email. Usá otro o iniciá sesión');

// DynamoDB: USER#<id>/PROFILE, EMAIL#<email>/EMAIL y USER#<id>/CREDENTIAL (solo el hash scrypt).
async function signupDynamo(email: string, fullName: string, passwordHash: string) {
  if (await getItem(`EMAIL#${email}`, 'EMAIL')) {
    throw duplicate();
  }
  const [userId] = await nextIds(1);
  const { token, item: session } = sessionItem(userId!);
  const now = new Date().toISOString();
  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName(),
              Item: { PK: `EMAIL#${email}`, SK: 'EMAIL', type: 'EMAIL', userId },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: {
                PK: `USER#${userId}`,
                SK: 'PROFILE',
                type: 'USER',
                userId,
                email,
                fullName,
                phone: '',
                role: 'customer',
                createdAt: now,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: {
                PK: `USER#${userId}`,
                SK: 'CREDENTIAL',
                type: 'CREDENTIAL',
                passwordHash,
                createdAt: now,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          { Put: { TableName: tableName(), Item: session } },
        ],
      }),
    );
  } catch (error) {
    if (cancellationCodes(error)?.[0] === 'ConditionalCheckFailed') {
      throw duplicate();
    }
    throw error;
  }
  return { customer: { id: userId!, full_name: fullName, email }, cookie: sessionCookie(token) };
}

async function accountDynamo(email: string) {
  const link = await getItem(`EMAIL#${email}`, 'EMAIL');
  if (!link) {
    return undefined;
  }
  const userId = String(link.userId);
  const items = await batchGet([
    { PK: `USER#${userId}`, SK: 'PROFILE' },
    { PK: `USER#${userId}`, SK: 'CREDENTIAL' },
  ]);
  const profile = items.find((i) => i.SK === 'PROFILE');
  const credential = items.find((i) => i.SK === 'CREDENTIAL');
  if (!profile || !credential || profile.role !== 'customer') {
    return undefined;
  }
  return {
    id: userId,
    full_name: String(profile.fullName),
    email,
    password_hash: String(credential.passwordHash),
  };
}

function emailInput(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  ) {
    throw new HttpError(400, 'Ingresá un email válido');
  }
  return value.trim().toLowerCase();
}

// Una Lambda dedicada a autenticación, con cuatro rutas de la misma responsabilidad.
export const execute: Operation = async (event, { pool, log }) => {
  const route = event.routeKey;
  const dynamoMode = useDynamo();
  if (route === 'GET /api/v1/auth/session') {
    return json({
      data: dynamoMode ? await requireSessionDynamo(event) : await requireSession(pool, event),
    });
  }
  if (route === 'POST /api/v1/auth/logout') {
    await (dynamoMode ? revokeSessionDynamo(event) : revokeSession(pool, event));
    log({ event: 'auth.logout' });
    return { ...json({ ok: true }), cookies: [sessionCookie('', true)] };
  }
  const registration = route === 'POST /api/v1/auth/signup';
  if (!registration && route !== 'POST /api/v1/auth/login') {
    throw new HttpError(404, 'Ruta de autenticación inexistente');
  }
  const input = body(
    event,
    registration ? ['full_name', 'email', 'password'] : ['email', 'password'],
  );
  const email = emailInput(input.email);
  const password = passwordInput(input.password, registration);
  await limitAuth(
    pool,
    registration ? 'signup' : 'login',
    email,
    event.requestContext.http.sourceIp,
  );

  if (registration) {
    if (
      typeof input.full_name !== 'string' ||
      input.full_name.trim().length < 2 ||
      input.full_name.trim().length > 120
    ) {
      throw new HttpError(400, 'El nombre debe tener entre 2 y 120 caracteres');
    }
    const fullName = input.full_name.trim();
    const passwordHash = await hashPassword(password);
    if (dynamoMode) {
      const result = await signupDynamo(email, fullName, passwordHash);
      log({ event: 'auth.signup', userId: result.customer.id });
      return { ...json({ data: result.customer }, 201), cookies: [result.cookie] };
    }
    try {
      const result = await transaction(pool, async (db) => {
        // Nunca asociar por email una cuenta nueva a compras de un usuario preexistente.
        const existing = await db.query('SELECT 1 FROM users WHERE lower(email)=$1 LIMIT 1', [
          email,
        ]);
        if (existing.rowCount) {
          throw new HttpError(409, 'No se pudo registrar ese email. Usá otro o iniciá sesión');
        }
        const user = await db.query<SessionUser>(
          `INSERT INTO users
          (id,email,full_name,phone,role,created_at,metadata_text)
          VALUES(nextval('api_entity_id_seq'),$1,$2,'','customer',now(),'{}') RETURNING id,full_name,email`,
          [email, fullName],
        );
        const customer = user.rows[0]!;
        await db.query('INSERT INTO store_accounts(user_id,email,password_hash) VALUES($1,$2,$3)', [
          customer.id,
          email,
          passwordHash,
        ]);
        return { customer, cookie: await issueSession(db, event, customer.id) };
      });
      log({ event: 'auth.signup', userId: result.customer.id });
      return { ...json({ data: result.customer }, 201), cookies: [result.cookie] };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new HttpError(409, 'No se pudo registrar ese email. Usá otro o iniciá sesión');
      }
      throw error;
    }
  }

  if (dynamoMode) {
    const customer = await accountDynamo(email);
    const valid = await verifyPassword(password, customer?.password_hash);
    if (!valid || !customer) {
      throw new HttpError(401, 'Email o contraseña incorrectos');
    }
    const cookie = await issueSessionDynamo(event, customer.id);
    log({ event: 'auth.login', userId: customer.id });
    return {
      ...json({ data: { id: customer.id, full_name: customer.full_name, email: customer.email } }),
      cookies: [cookie],
    };
  }
  const account = await pool.query<SessionUser & { password_hash: string }>(
    `
    SELECT u.id,u.full_name,a.email,a.password_hash
    FROM store_accounts a JOIN users u ON u.id=a.user_id
    WHERE a.email=$1 AND u.role='customer'`,
    [email],
  );
  const customer = account.rows[0];
  const valid = await verifyPassword(password, customer?.password_hash);
  if (!valid || !customer) {
    throw new HttpError(401, 'Email o contraseña incorrectos');
  }
  const cookie = await transaction(pool, (db) => issueSession(db, event, customer.id));
  log({ event: 'auth.login', userId: customer.id });
  return {
    ...json({ data: { id: customer.id, full_name: customer.full_name, email: customer.email } }),
    cookies: [cookie],
  };
};

export const handler = lambda('auth', execute, { authentication: 'public' });
