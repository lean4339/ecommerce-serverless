import { randomUUID } from 'node:crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';

export const live = !!process.env.E2E_BASE_URL && !process.env.E2E_BASE_URL.includes('127.0.0.1');
export const newAccount = () => ({
  full_name: 'Regresión E2E',
  email: `e2e-${Date.now()}-${randomUUID().slice(0, 6)}@example.test`,
  password: `E2e-${randomUUID()}`,
});

// API Gateway del stack: 2 req/s y ráfaga 5. Contra producción espaciamos a ~1 req/s.
const gap = live ? 1100 : 0;
let last = 0;
async function pace() {
  const wait = last + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

export class Api {
  constructor(
    private request: APIRequestContext,
    private origin: string,
  ) {}
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    await pace();
    const response: APIResponse = await this.request.fetch(`/api/v1${path}`, {
      method,
      headers: { origin: this.origin, ...headers },
      ...(body === undefined ? {} : { data: body }),
    });
    const text = await response.text();
    return { status: response.status(), body: text ? JSON.parse(text) : null };
  }
}

// "Forma" de una respuesta: claves y tipos, recursivo (los arrays usan su primer elemento).
export function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  }
  return value === null ? 'null' : typeof value;
}
