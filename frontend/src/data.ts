export type Row = Record<string, any>;
export function money(value: string | number | null | undefined) {
  const n = BigInt(value ?? 0);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  return `${negative ? '-' : ''}$ ${new Intl.NumberFormat('es-AR').format(abs / 100n)},${String(abs % 100n).padStart(2, '0')}`;
}
export const number = (value: string | number) =>
  new Intl.NumberFormat('es-AR').format(BigInt(value));
export const date = (value: string) =>
  new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date(value));
export const initials = (name: string) =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();
export async function api<T = any>(path: string, options: RequestInit = {}) {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event('nexo:session-expired'));
    }
    throw new ApiError(data.error ?? 'No pudimos completar la operación', response.status);
  }
  return data as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
