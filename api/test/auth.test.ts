import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Context } from 'aws-lambda';
import { createPool } from '../src/db.js';
import { execute as auth } from '../src/functions/auth.js';
import { execute as getCart } from '../src/functions/get-cart.js';
import { execute as getCustomer } from '../src/functions/get-customer.js';
import { execute as createAddress } from '../src/functions/create-address.js';
import { execute as getOrder } from '../src/functions/get-order.js';
import { execute as updateCart } from '../src/functions/update-cart.js';
import { execute as createOrder } from '../src/functions/create-order.js';
import { lambda, type Event } from '../src/shared/http.js';
import { sessionCookie, tokenHash } from '../src/shared/sessions.js';

process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
process.env.LOCAL_DEVELOPMENT = 'true';
const ORIGIN = process.env.APP_ORIGIN;
const PASSWORD = 'Prueba-solo-local-2026!';

test('Autenticación por Lambda con cuentas y sesiones reales en PostgreSQL', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Usá npm test');
  const pool = createPool(process.env.TEST_DATABASE_URL);
  const logs: Record<string, unknown>[] = [];
  const options = { pool, log: (record: Record<string, unknown>) => logs.push(record) };
  const login = lambda('auth', auth, { ...options, authentication: 'public' });
  const handlers = {
    'get-cart': lambda('get-cart', getCart, options),
    'update-cart': lambda('update-cart', updateCart, options),
    'get-customer': lambda('get-customer', getCustomer, options),
    'create-address': lambda('create-address', createAddress, options),
    'create-order': lambda('create-order', createOrder, options),
    'get-order': lambda('get-order', getOrder, options),
  };
  async function request(
    handler: ReturnType<typeof lambda>,
    method: string,
    path: string,
    input: { body?: unknown; cookie?: string; origin?: string; id?: string; key?: string } = {},
  ) {
    const event = {
      version: '2.0',
      routeKey: `${method} ${path}`,
      rawPath: path,
      rawQueryString: '',
      headers: {
        origin: input.origin ?? ORIGIN,
        ...(input.key ? { 'idempotency-key': input.key } : {}),
      },
      cookies: input.cookie ? [input.cookie] : undefined,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      isBase64Encoded: false,
      pathParameters: input.id ? { id: input.id } : {},
      requestContext: {
        accountId: 'local',
        apiId: 'local',
        domainName: 'localhost',
        domainPrefix: 'local',
        stage: '$default',
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
        requestId: randomUUID(),
        routeKey: `${method} ${path}`,
        http: { method, path, sourceIp: '127.0.0.2', protocol: 'HTTP/1.1', userAgent: 'test' },
      },
    } as Event;
    const result = await handler(event, { awsRequestId: randomUUID() } as Context);
    return {
      status: result.statusCode,
      data: JSON.parse(result.body),
      cookie: result.cookies?.[0]?.split(';')[0],
      raw: result,
    };
  }
  const prefix = randomUUID();
  const firstEmail = `${prefix}-one@example.test`;
  const secondEmail = `${prefix}-two@example.test`;
  let firstCookie = '';
  let firstId = '';
  let secondCookie = '';
  try {
    await t.test('Sin cookie no hay acceso; un user_id del cliente no autentica', async () => {
      assert.equal((await request(handlers['get-cart'], 'GET', '/api/v1/cart')).status, 401);
      assert.equal(
        (
          await request(handlers['update-cart'], 'PUT', '/api/v1/cart', {
            body: { user_id: '1', version: 0, items: [] },
          })
        ).status,
        401,
      );
    });
    await t.test('Registro crea cuenta, hash scrypt, sesión y cookie HttpOnly', async () => {
      const result = await request(login, 'POST', '/api/v1/auth/signup', {
        body: { full_name: 'Usuario Uno', email: firstEmail.toUpperCase(), password: PASSWORD },
      });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      firstCookie = result.cookie!;
      firstId = result.data.data.id;
      assert.equal(result.data.data.email, firstEmail);
      assert.match(result.raw.cookies![0]!, /HttpOnly; SameSite=Strict/);
      assert.ok(!JSON.stringify(result.data).includes('password'));
      const account = (
        await pool.query('SELECT password_hash FROM store_accounts WHERE user_id=$1', [firstId])
      ).rows[0];
      assert.match(account.password_hash, /^scrypt\$131072\$8\$1\$/);
      assert.ok(!account.password_hash.includes(PASSWORD));
      const token = firstCookie.split('=')[1]!;
      const session = (
        await pool.query('SELECT token_hash FROM store_sessions WHERE user_id=$1', [firstId])
      ).rows[0];
      assert.notEqual(session.token_hash, token);
      assert.equal(session.token_hash, tokenHash(token));
      const current = await request(login, 'GET', '/api/v1/auth/session', { cookie: firstCookie });
      assert.equal(current.data.data.id, firstId);
      const second = await request(login, 'POST', '/api/v1/auth/signup', {
        body: { full_name: 'Usuario Dos', email: secondEmail, password: PASSWORD },
      });
      assert.equal(second.status, 201);
      secondCookie = second.cookie!;
      const other = (
        await pool.query('SELECT password_hash FROM store_accounts WHERE email=$1', [secondEmail])
      ).rows[0];
      assert.notEqual(
        account.password_hash,
        other.password_hash,
        'salts diferentes para la misma contraseña',
      );
    });
    await t.test('Registros concurrentes del mismo email crean una sola cuenta', async () => {
      const email = `${prefix}-race@example.test`;
      const payload = { full_name: 'Cuenta concurrente', email, password: PASSWORD };
      const results = await Promise.all([
        request(login, 'POST', '/api/v1/auth/signup', { body: payload }),
        request(login, 'POST', '/api/v1/auth/signup', { body: payload }),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
      assert.equal(
        (await pool.query('SELECT count(*) AS n FROM users WHERE email=$1', [email])).rows[0].n,
        '1',
      );
      assert.equal(
        (await pool.query('SELECT count(*) AS n FROM store_accounts WHERE email=$1', [email]))
          .rows[0].n,
        '1',
      );
    });
    await t.test('Email duplicado y campos inválidos no crean usuarios huérfanos', async () => {
      const before = (await pool.query('SELECT count(*) AS n FROM users')).rows[0].n;
      const repeated = await request(login, 'POST', '/api/v1/auth/signup', {
        body: { full_name: 'Otro nombre', email: firstEmail, password: PASSWORD },
      });
      assert.equal(repeated.status, 409);
      assert.equal((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n, before);
      for (const change of [{ password: 'corta' }, { role: 'staff' }, { full_name: '' }]) {
        const result = await request(login, 'POST', '/api/v1/auth/signup', {
          body: {
            full_name: 'Usuario',
            email: `${prefix}-invalid@example.test`,
            password: PASSWORD,
            ...change,
          },
        });
        assert.equal(result.status, 400);
      }
    });
    await t.test('Login devuelve error genérico y rota la sesión al ingresar', async () => {
      const wrong = await request(login, 'POST', '/api/v1/auth/login', {
        body: { email: firstEmail, password: 'incorrecta' },
      });
      const missing = await request(login, 'POST', '/api/v1/auth/login', {
        body: { email: `${prefix}-missing@example.test`, password: 'incorrecta' },
      });
      assert.equal(wrong.status, 401);
      assert.equal(missing.status, 401);
      assert.equal(wrong.data.error, missing.data.error);
      const previous = firstCookie;
      const valid = await request(login, 'POST', '/api/v1/auth/login', {
        cookie: previous,
        body: { email: firstEmail, password: PASSWORD },
      });
      assert.equal(valid.status, 200);
      firstCookie = valid.cookie!;
      assert.notEqual(firstCookie, previous);
      assert.equal(
        (await request(handlers['get-cart'], 'GET', '/api/v1/cart', { cookie: previous })).status,
        401,
      );
    });
    await t.test(
      'Origen ajeno o ausente no puede registrar, iniciar sesión ni modificar carrito',
      async () => {
        for (const origin of ['https://evil.example', '']) {
          assert.equal(
            (
              await request(login, 'POST', '/api/v1/auth/login', {
                origin,
                body: { email: firstEmail, password: PASSWORD },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(handlers['update-cart'], 'PUT', '/api/v1/cart', {
                origin,
                cookie: firstCookie,
                body: { version: 0, items: [] },
              })
            ).status,
            403,
          );
        }
      },
    );
    await t.test('Carrito, dirección y pedido pertenecen al usuario de la sesión', async () => {
      const address = await request(
        handlers['create-address'],
        'POST',
        '/api/v1/store/customer/addresses',
        {
          cookie: firstCookie,
          body: { street: 'Prueba 123', city: 'CABA', country: 'AR', postal_code: '1000' },
        },
      );
      assert.equal(address.status, 201);
      const owner = await request(handlers['get-customer'], 'GET', '/api/v1/store/customer', {
        cookie: firstCookie,
      });
      assert.equal(owner.data.data.id, firstId);
      assert.equal(owner.data.data.addresses[0].id, address.data.data.id);
      const cart = await request(handlers['update-cart'], 'PUT', '/api/v1/cart', {
        cookie: firstCookie,
        body: { version: 0, items: [{ variant_id: '10', quantity: 1 }] },
      });
      assert.equal(cart.status, 200, JSON.stringify(cart.data));
      assert.equal(
        (await request(handlers['get-cart'], 'GET', '/api/v1/cart', { cookie: secondCookie })).data
          .data.items.length,
        0,
      );
      const order = await request(handlers['create-order'], 'POST', '/api/v1/orders', {
        cookie: firstCookie,
        key: randomUUID(),
        body: { cart_version: cart.data.data.version, address_id: address.data.data.id },
      });
      assert.equal(order.status, 201, JSON.stringify(order.data));
      const id = order.data.data.id;
      assert.equal(
        (
          await request(handlers['get-order'], 'GET', '/api/v1/orders/{id}', {
            cookie: secondCookie,
            id,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request(handlers['get-order'], 'GET', '/api/v1/orders/{id}', {
            cookie: firstCookie,
            id,
          })
        ).status,
        200,
      );
    });
    await t.test('Sesión vencida y logout revocado bloquean acceso inmediatamente', async () => {
      await pool.query(
        "UPDATE store_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [tokenHash(secondCookie.split('=')[1]!)],
      );
      assert.equal(
        (await request(handlers['get-cart'], 'GET', '/api/v1/cart', { cookie: secondCookie }))
          .status,
        401,
      );
      const result = await request(login, 'POST', '/api/v1/auth/logout', { cookie: firstCookie });
      assert.equal(result.status, 200);
      assert.match(result.raw.cookies![0]!, /Max-Age=0/);
      assert.equal(
        (await request(handlers['get-cart'], 'GET', '/api/v1/cart', { cookie: firstCookie }))
          .status,
        401,
      );
    });
    await t.test('El límite persistente devuelve 429 antes de verificar contraseñas', async () => {
      const email = `${prefix}-limited@example.test`;
      await pool.query('INSERT INTO store_auth_limits(bucket_key,attempts) VALUES($1,10)', [
        tokenHash('login:email:' + email),
      ]);
      const result = await request(login, 'POST', '/api/v1/auth/login', {
        body: { email, password: PASSWORD },
      });
      assert.equal(result.status, 429);
      assert.equal(result.raw.headers?.['retry-after'], '900');
    });
    await t.test('Cookie segura en AWS y logs sin contraseñas ni tokens', () => {
      process.env.APP_ORIGIN = 'https://shop.example.test';
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'auth';
      try {
        assert.match(sessionCookie('example'), /^__Host-nexo_session=/);
        assert.match(sessionCookie('example'), /; Secure$/);
      } finally {
        delete process.env.AWS_LAMBDA_FUNCTION_NAME;
        process.env.APP_ORIGIN = ORIGIN;
      }
      const output = JSON.stringify(logs);
      assert.ok(!output.includes(PASSWORD));
      assert.ok(!output.includes(firstCookie.split('=')[1]!));
      assert.ok(!output.includes(firstEmail));
    });
  } finally {
    await pool.end();
  }
});
