import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../db.js';

// scrypt es deliberadamente costoso: 128 MiB de memoria por derivación.
// La Lambda auth tiene 512 MiB. No usamos SHA-256 para hashear contraseñas.
const PARAMETERS = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const PREFIX = 'scrypt$131072$8$1';
const DUMMY = `${PREFIX}$${Buffer.alloc(16, 17).toString('base64url')}$${Buffer.alloc(64).toString('base64url')}`;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, PARAMETERS, (error, hash) => {
      if (error) {
        reject(error);
      } else {
        resolve(hash);
      }
    });
  });
}

export function passwordInput(value: unknown, registration = false): string {
  const minimum = registration ? 12 : 1;
  if (typeof value !== 'string' || value.length < minimum || value.length > 128) {
    throw new HttpError(
      400,
      registration
        ? 'La contraseña debe tener entre 12 y 128 caracteres'
        : 'Credenciales inválidas',
    );
  }
  return value;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `${PREFIX}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded?: string): Promise<boolean> {
  // También derivamos si el email no existe: mismo costo y mismo mensaje de error.
  const parts = (encoded ?? DUMMY).split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== PREFIX) {
    throw new Error('Formato de contraseña almacenada inválido');
  }
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length !== 16 || expected.length !== 64) {
    throw new Error('Hash de contraseña almacenada inválido');
  }
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && encoded !== undefined;
}
