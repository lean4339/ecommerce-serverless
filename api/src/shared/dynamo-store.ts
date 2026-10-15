import { HttpError } from '../db.js';
import type { Cart, Item } from './cart.js';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  batchGet,
  dynamo,
  getItem,
  pad,
  queryAll,
  str,
  tableName,
  type DynamoItem,
} from './dynamo.js';

// Lecturas de la tienda sobre la tabla única. Devuelven exactamente las mismas formas
// JSON que las consultas de PostgreSQL (bigint y numeric como string, null explícitos).

export async function readCartDynamo(customerId: string): Promise<Cart> {
  const cart = await getItem(`USER#${customerId}`, 'CART');
  return cart
    ? {
        version: Number(cart.version ?? 0),
        items: ((cart.items as Item[] | undefined) ?? []).map((i) => ({
          variant_id: String(i.variant_id),
          quantity: Number(i.quantity),
        })),
      }
    : { version: 0, items: [] };
}

export type VariantInfo = {
  variant_id: string;
  product_id: string;
  color: string | null;
  size: string | null;
  price_cents: string;
  name: string;
  status: string;
  stock: number;
};

export async function variantsInfo(variantIds: string[]): Promise<Map<string, VariantInfo>> {
  const refs = await batchGet(variantIds.map((id) => ({ PK: `VARIANT#${id}`, SK: 'META' })));
  const productOf = new Map(refs.map((r) => [String(r.variantId), String(r.productId)]));
  const items = await batchGet(
    [...productOf].flatMap(([variantId, productId]) => [
      { PK: `PRODUCT#${productId}`, SK: `VARIANT#${pad(variantId)}` },
      { PK: `PRODUCT#${productId}`, SK: 'META' },
    ]),
  );
  const products = new Map(items.filter((i) => i.SK === 'META').map((i) => [i.PK, i]));
  const result = new Map<string, VariantInfo>();
  for (const v of items.filter((i) => String(i.SK).startsWith('VARIANT#'))) {
    const p = products.get(v.PK as string);
    if (!p) {
      continue;
    }
    result.set(String(v.variantId), {
      variant_id: String(v.variantId),
      product_id: String(v.productId),
      color: str(v.color),
      size: str(v.size),
      price_cents: String(v.priceCents),
      name: String(p.name),
      status: String(p.status),
      stock: Number(v.stock ?? 0),
    });
  }
  return result;
}

export async function cartViewDynamo(cart: Cart) {
  if (!cart.items.length) {
    return { ...cart, total_cents: '0' };
  }
  const variants = await variantsInfo(cart.items.map((i) => i.variant_id));
  let total = 0n;
  const resolved = cart.items.map((item) => {
    const v = variants.get(item.variant_id);
    if (!v) {
      throw new HttpError(409, 'Un artículo del carrito ya no existe');
    }
    total += BigInt(v.price_cents) * BigInt(item.quantity);
    return {
      variant_id: v.variant_id,
      product_id: v.product_id,
      color: v.color,
      size: v.size,
      price_cents: v.price_cents,
      name: v.name,
      status: v.status,
      available: v.status === 'active' ? v.stock : 0,
      quantity: item.quantity,
    };
  });
  return { version: cart.version, items: resolved, total_cents: total.toString() };
}

export const addressView = (a: DynamoItem) => ({
  id: String(a.addressId),
  street: str(a.street),
  city: str(a.city),
  country: str(a.country),
  postal_code: str(a.postalCode),
});

export async function orderViewDynamo(orderId: string, customerId: string) {
  const items = await queryAll({
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `ORDER#${orderId}` },
    ConsistentRead: true,
  });
  const meta = items.find((i) => i.SK === 'META');
  if (!meta || String(meta.userId) !== customerId) {
    throw new HttpError(404, 'Pedido inexistente');
  }
  const address = meta.addressId
    ? await getItem(`USER#${customerId}`, `ADDR#${pad(String(meta.addressId))}`)
    : undefined;
  return {
    id: String(meta.orderId),
    status: str(meta.status),
    currency: str(meta.currency),
    total_cents: str(meta.totalCents),
    created_at: str(meta.createdAt),
    address_id: str(meta.addressId),
    items: items
      .filter((i) => String(i.SK).startsWith('ITEM#'))
      .map((i) => ({
        variant_id: str(i.variantId),
        product_name_snapshot: str(i.productName),
        quantity: Number(i.quantity),
        unit_price_cents: str(i.unitPriceCents),
      })),
    status_history: items
      .filter((i) => String(i.SK).startsWith('STATUS#'))
      .map((i) => ({ status: str(i.status), created_at: str(i.createdAt) })),
    address: address
      ? {
          street: str(address.street),
          city: str(address.city),
          country: str(address.country),
          postal_code: str(address.postalCode),
        }
      : undefined,
  };
}

// Catálogo: GSI1 (CAT#<id>) por categoría, con caché breve por instancia Lambda.
const CACHE_MS = 30_000;
const categoryCache = new Map<string, { at: number; items: Promise<DynamoItem[]> }>();
let filtersCache: { at: number; items: Promise<DynamoItem[]> } | undefined;

export function filtersDynamo(): Promise<DynamoItem[]> {
  if (!filtersCache || Date.now() - filtersCache.at > CACHE_MS) {
    const items = queryAll({
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'FILTERS' },
    });
    filtersCache = { at: Date.now(), items };
    items.catch(() => (filtersCache = undefined));
  }
  return filtersCache.items;
}

export function productsInCategory(categoryId: string): Promise<DynamoItem[]> {
  const cached = categoryCache.get(categoryId);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.items;
  }
  const items = queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `CAT#${categoryId}` },
    ProjectionExpression:
      'productId,#n,description,createdAt,categoryId,categoryName,brandId,brandName,priceCents,availableUnits,rating,reviewCount,soldUnits,#v,#s',
    ExpressionAttributeNames: { '#n': 'name', '#v': 'views', '#s': 'status' },
  });
  categoryCache.set(categoryId, { at: Date.now(), items });
  items.catch(() => categoryCache.delete(categoryId));
  return items;
}

// Concurrencia acotada: nunca más de `limit` consultas en vuelo (el SDK tiene 50 sockets).
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
}

const LISTING =
  'PK,SK,GSI2PK,GSI2SK,productId,#n,description,createdAt,categoryId,categoryName,brandId,brandName,priceCents,availableUnits,rating,reviewCount,soldUnits,#v,#s';
const LISTING_NAMES = { '#n': 'name', '#v': 'views', '#s': 'status' };

// GSI2 en orden "popular". Lee por tandas hasta juntar `wanted` coincidencias o `maxScanned` ítems.
// Devuelve la clave del último ítem consumido para continuar exactamente desde ahí.
export async function catalogPage(
  accept: (item: DynamoItem) => boolean,
  wanted: number,
  start: Record<string, unknown> | undefined,
  maxScanned: number,
) {
  const items: DynamoItem[] = [];
  let scanned = 0;
  let key = start;
  let last: Record<string, unknown> | undefined;
  while (items.length < wanted && scanned < maxScanned) {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': 'CATALOG' },
        ProjectionExpression: LISTING,
        ExpressionAttributeNames: LISTING_NAMES,
        Limit: Math.min(Math.max(wanted - items.length + 1, 25), 500),
        ExclusiveStartKey: key,
      }),
    );
    const page = result.Items ?? [];
    for (const [index, item] of page.entries()) {
      scanned++;
      last = { PK: item.PK, SK: item.SK, GSI2PK: item.GSI2PK, GSI2SK: item.GSI2SK };
      if (accept(item)) {
        items.push(item);
      }
      if (items.length === wanted) {
        const endOfIndex = index === page.length - 1 && !result.LastEvaluatedKey;
        return { items, next: endOfIndex ? undefined : last };
      }
    }
    if (!result.LastEvaluatedKey) {
      return { items, next: undefined };
    }
    key = result.LastEvaluatedKey;
  }
  return { items, next: last };
}

let catalogCache: { at: number; items: Promise<DynamoItem[]> } | undefined;
export function wholeCatalog(): Promise<DynamoItem[]> {
  if (!catalogCache || Date.now() - catalogCache.at > CACHE_MS) {
    const items = catalogIndexReady().then(async (ready) => {
      if (ready) {
        return queryAll({
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :pk',
          ExpressionAttributeValues: { ':pk': 'CATALOG' },
          ProjectionExpression: LISTING,
          ExpressionAttributeNames: LISTING_NAMES,
        });
      }
      // Sin GSI2 (despliegue a medias): categorías por GSI1 con concurrencia acotada.
      const categories = (await filtersDynamo()).filter((i) => String(i.SK).startsWith('CAT#'));
      return (
        await mapLimit(categories, 10, (c) => productsInCategory(String(c.categoryId)))
      ).flat();
    });
    catalogCache = { at: Date.now(), items };
    items.catch(() => (catalogCache = undefined));
  }
  return catalogCache.items;
}

// FILTERS/STATS lo escribe la migración/backfill cuando GSI2 está completo.
export async function activeProductCount(): Promise<number> {
  const stats = (await filtersDynamo()).find((i) => i.SK === 'STATS');
  return Number(stats?.activeProducts ?? 0);
}
export async function catalogIndexReady(): Promise<boolean> {
  return (await filtersDynamo()).some((i) => i.SK === 'STATS');
}
