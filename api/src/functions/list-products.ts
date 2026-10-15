import { HttpError, id } from '../db.js';
import { useDynamo } from '../shared/dynamo.js';
import {
  activeProductCount,
  catalogIndexReady,
  catalogPage,
  filtersDynamo,
  mapLimit,
  productsInCategory,
  wholeCatalog,
} from '../shared/dynamo-store.js';
import type { DynamoItem } from '../shared/dynamo.js';
import { catalogQuery, type CatalogQuery } from '../catalog.js';
import { lambda, json, integer, type Operation } from '../shared/http.js';
// --- DynamoDB ---------------------------------------------------------------------------
// 1) Sin categoría, orden "popular" y sin filtros (la portada): un Query paginado sobre GSI2
//    (GSI2PK=CATALOG, GSI2SK=ventas invertidas+id). total sale de FILTERS/STATS.
// 2) Con categoría: GSI1 (CAT#<id> y subcategorías) con fan-out acotado a 10 consultas.
// 3) Otros órdenes o filtros (búsqueda, marca, precio, valoración, stock): se necesita el
//    conjunto completo para devolver el mismo `total` exacto y el mismo orden que PostgreSQL.
//    Se lee GSI2 entero (proyección reducida, ~6 páginas de 1 MB, sin fan-out) y se cachea 30 s.
// Modo cursor (solo DynamoDB, opt-in con ?cursor=): agrega next_cursor. En orden "popular"
// con filtros lee GSI2 por tandas y se detiene al llenar la página (máx. 2000 ítems leídos);
// en ese caso `total` es null porque contarlo exigiría recorrer todo el catálogo.
type Row = ReturnType<typeof toRow>;
const toRow = (p: DynamoItem) => ({
  id: String(p.productId),
  name: p.name,
  created_at: p.createdAt,
  category_id: String(p.categoryId),
  category_name: p.categoryName,
  brand_name: p.brandName,
  price_cents: String(p.priceCents),
  available_units: String(Math.max(0, Number(p.availableUnits ?? 0))),
  rating: p.rating === undefined ? null : String(p.rating),
  review_count: String(p.reviewCount ?? '0'),
  sold_units: String(p.soldUnits ?? '0'),
  views: String(p.views ?? '0'),
});
const big = (v: string) => BigInt(v);
const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a: Row, b: Row) => cmp(big(a.id), big(b.id));
const orders: Record<string, (a: Row, b: Row) => number> = {
  popular: (a, b) => cmp(big(b.sold_units), big(a.sold_units)) || byId(a, b),
  trending: (a, b) => cmp(big(b.views), big(a.views)) || byId(a, b),
  price_asc: (a, b) => cmp(big(a.price_cents), big(b.price_cents)) || byId(a, b),
  price_desc: (a, b) => cmp(big(b.price_cents), big(a.price_cents)) || byId(a, b),
  rating: (a, b) =>
    (a.rating === null ? 1 : 0) - (b.rating === null ? 1 : 0) ||
    Number(b.rating ?? 0) - Number(a.rating ?? 0) ||
    cmp(big(b.review_count), big(a.review_count)) ||
    byId(a, b),
  newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || byId(a, b),
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // cae al error de abajo
  }
  throw new HttpError(400, 'Cursor inválido');
}
const MAX_SCANNED = 2000;

async function listDynamo(q: CatalogQuery, cursor: string | undefined) {
  const sort = q.sort ?? 'popular';
  const limit = q.limit ?? 24;
  const page = q.page ?? 1;
  const order = orders[sort];
  if (!order) {
    throw new HttpError(400, 'Orden inválido');
  }
  for (const field of ['min_cents', 'max_cents'] as const) {
    if (q[field] !== undefined) {
      id(q[field], true);
    }
  }
  if (q.min_cents && q.max_cents && BigInt(q.min_cents) > BigInt(q.max_cents)) {
    throw new HttpError(400, 'El precio mínimo supera al máximo');
  }
  const brandId = q.brand_id ? id(q.brand_id) : undefined;
  const search = q.q?.trim().toLowerCase();
  const filtered =
    !!search ||
    !!brandId ||
    q.min_cents !== undefined ||
    q.max_cents !== undefined ||
    q.min_rating !== undefined ||
    !!q.in_stock;
  const matches = (p: DynamoItem) =>
    p.status === 'active' &&
    (!search ||
      String(p.name ?? '')
        .toLowerCase()
        .includes(search) ||
      String(p.description ?? '')
        .toLowerCase()
        .includes(search)) &&
    (!brandId || String(p.brandId) === brandId) &&
    (q.min_cents === undefined || BigInt(String(p.priceCents)) >= BigInt(q.min_cents)) &&
    (q.max_cents === undefined || BigInt(String(p.priceCents)) <= BigInt(q.max_cents)) &&
    (q.min_rating === undefined || Number(p.rating ?? 0) >= q.min_rating) &&
    (!q.in_stock || Number(p.availableUnits ?? 0) > 0);
  const cursorMode = cursor !== undefined;
  const start = cursor ? decode(cursor) : undefined;

  if (!q.category_id && sort === 'popular' && (await catalogIndexReady())) {
    if (cursorMode && !start?.o) {
      // Orden del índice: Query con Limit + LastEvaluatedKey, sin leer el catálogo entero.
      const { items, next } = await catalogPage(
        filtered ? matches : (p) => p.status === 'active',
        limit,
        start as Record<string, unknown> | undefined,
        MAX_SCANNED,
      );
      return {
        data: items.map(toRow),
        total: filtered ? null : String(await activeProductCount()),
        page,
        limit,
        next_cursor: next ? encode(next) : null,
      };
    }
    if (!cursorMode && !filtered) {
      const { items } = await catalogPage(() => true, page * limit, undefined, Infinity);
      return {
        data: items.slice((page - 1) * limit).map(toRow),
        total: String(await activeProductCount()),
        page,
        limit,
      };
    }
  }

  let source: DynamoItem[];
  if (q.category_id) {
    const categories = (await filtersDynamo()).filter((i) => String(i.SK).startsWith('CAT#'));
    const root = id(q.category_id);
    const children = new Map<string, string[]>();
    for (const c of categories) {
      const parent = c.parentId === undefined ? '' : String(c.parentId);
      children.set(parent, [...(children.get(parent) ?? []), String(c.categoryId)]);
    }
    const seen = new Set([root]);
    const stack = [root];
    while (stack.length) {
      for (const child of children.get(stack.pop()!) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          stack.push(child);
        }
      }
    }
    source = (await mapLimit([...seen], 10, productsInCategory)).flat();
  } else {
    source = await wholeCatalog();
  }
  const rows = source.filter(matches).map(toRow).sort(order);
  const offset = cursorMode ? Number(start?.o ?? 0) : (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new HttpError(400, 'Cursor inválido');
  }
  const data = rows.slice(offset, offset + limit);
  return {
    data,
    total: String(rows.length),
    page,
    limit,
    ...(cursorMode
      ? { next_cursor: offset + limit < rows.length ? encode({ o: offset + limit }) : null }
      : {}),
  };
}

export const execute: Operation = async (event, { pool }) => {
  const input = event.queryStringParameters ?? {};
  const allowed = [
    'q',
    'category_id',
    'brand_id',
    'sort',
    'page',
    'limit',
    'min_cents',
    'max_cents',
    'min_rating',
    'in_stock',
    // Paginación por cursor: solo en modo DynamoDB.
    ...(useDynamo() ? ['cursor'] : []),
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, 'Filtro desconocido');
  }
  if (input.q && input.q.length > 100) {
    throw new HttpError(400, 'Búsqueda demasiado larga');
  }
  const query: CatalogQuery = {
    q: input.q,
    category_id: input.category_id,
    brand_id: input.brand_id,
    sort: input.sort,
    min_cents: input.min_cents,
    max_cents: input.max_cents,
    page: integer(Number(input.page ?? 1), 1, 100000),
    limit: integer(Number(input.limit ?? 24), 1, 48),
  };
  if (input.min_rating !== undefined) {
    const rating = Number(input.min_rating);
    if (!input.min_rating.trim() || !Number.isFinite(rating) || rating < 0 || rating > 5) {
      throw new HttpError(400, 'Valoración inválida');
    }
    query.min_rating = rating;
  }
  if (input.in_stock !== undefined) {
    if (!['true', 'false'].includes(input.in_stock)) {
      throw new HttpError(400, 'in_stock debe ser true o false');
    }
    query.in_stock = input.in_stock === 'true';
  }
  const started = performance.now();
  if (useDynamo()) {
    return json({
      ...(await listDynamo(query, input.cursor)),
      elapsed_ms: Math.round(performance.now() - started),
    });
  }
  const { sql, values, page, limit } = catalogQuery(query);
  const t0 = performance.now();
  const client = await pool.connect();

  try {
    console.log('CONNECT_MS', performance.now() - t0);

    const t1 = performance.now();
    const result = await client.query(sql, values);
    console.log('QUERY_MS', performance.now() - t1);

    return json({
      data: result.rows.filter((r) => r.id !== null).map(({ total, ...row }) => row),
      total: result.rows[0]?.total ?? '0',
      page,
      limit,
      elapsed_ms: Math.round(performance.now() - started),
    });
  } finally {
    client.release();
  }
};
export const handler = lambda('list-products', execute);
