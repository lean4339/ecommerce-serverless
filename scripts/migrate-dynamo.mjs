// Migra ecommerce_lab (Postgres local, solo lectura) a la tabla única "nexo" de DynamoDB.
// Uso:
//   node scripts/migrate-dynamo.mjs                       -> DynamoDB Local (recrea la tabla)
//   node scripts/migrate-dynamo.mjs --target aws --yes    -> tabla real del stack (no la crea ni la borra)
// Deps en ~/nexo-dynamo-migration (o MIGRATION_DEPS). No copia hashes de contraseñas, secretos,
// metadata_text ni browsing_events (de ahí solo se lee el conteo agregado de vistas).
import { createRequire } from 'node:module';
import os from 'node:os';
const require = createRequire(
  `${process.env.MIGRATION_DEPS ?? os.homedir() + '/nexo-dynamo-migration'}/package.json`,
);
const pg = require('pg');
const {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const args = process.argv.slice(2);
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'local';
if (!['local', 'aws'].includes(target)) throw new Error('--target debe ser local o aws');
if (target === 'aws' && !args.includes('--yes'))
  throw new Error('Para escribir en AWS agregá --yes');
const TABLE = process.env.TABLE_NAME ?? 'nexo';
const BATCH = 2000;
const CONC = Number(process.env.MIGRATION_CONCURRENCY ?? 8);
const PG = process.env.PG_URL ?? 'postgres://lab:lab_local_only@127.0.0.1:5433/ecommerce_lab';
const ENDPOINT = process.env.DYNAMO_ENDPOINT ?? 'http://127.0.0.1:8000';
if (target === 'local' && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(ENDPOINT)) {
  throw new Error('En modo local solo se admite DynamoDB Local');
}
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(PG))
  throw new Error('La fuente debe ser el Postgres local');

const ddb =
  target === 'local'
    ? new DynamoDBClient({
        endpoint: ENDPOINT,
        region: 'us-east-1',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      })
    : new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-2', maxAttempts: 10 });
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });
const db = new pg.Client({ connectionString: PG });
const counts = {};

const pad = (id) => String(id).padStart(19, '0');
// GSI2: catálogo activo en orden "popular" (ventas DESC, id ASC) con un Query ascendente.
const popularKey = (sold, id) =>
  `${String(10n ** 15n - BigInt(sold ?? 0)).padStart(16, '0')}#${pad(id)}`;
const GSI2_ATTRIBUTES = [
  'productId',
  'name',
  'description',
  'createdAt',
  'categoryId',
  'categoryName',
  'brandId',
  'brandName',
  'priceCents',
  'availableUnits',
  'rating',
  'reviewCount',
  'soldUnits',
  'views',
  'status',
];
let activeProducts = 0;
const iso = (d) => (d instanceof Date ? d.toISOString() : d);
const s = (v) => (v === null || v === undefined ? undefined : String(v)); // bigint/numeric -> string
const clean = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

async function writeChunk(items) {
  let req = { [TABLE]: items.map((Item) => ({ PutRequest: { Item } })) };
  for (let i = 0; req[TABLE]?.length; i++) {
    const r = await doc.send(new BatchWriteCommand({ RequestItems: req }));
    req = r.UnprocessedItems ?? {};
    if (req[TABLE]?.length) {
      if (i > 12) throw new Error('UnprocessedItems persistentes');
      await new Promise((ok) => setTimeout(ok, 50 * 2 ** Math.min(i, 7)));
    }
  }
}
async function writeAll(items) {
  const chunks = [];
  for (let i = 0; i < items.length; i += 25) chunks.push(items.slice(i, i + 25));
  let k = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (k < chunks.length) await writeChunk(chunks[k++]);
    }),
  );
  for (const it of items) counts[it.type] = (counts[it.type] ?? 0) + 1;
}
// Paginación por clave (keyset) sobre x.id
async function stream(name, sql, map) {
  let last = 0;
  let n = 0;
  for (;;) {
    const { rows } = await db.query(
      sql.replace('$WHERE', 'x.id > $1') + ' ORDER BY x.id LIMIT $2',
      [last, BATCH],
    );
    if (!rows.length) break;
    const items = (await Promise.all(rows.map(map))).flat();
    await writeAll(items);
    last = rows.at(-1).id;
    n += rows.length;
    process.stdout.write(`\r${name}: ${n}   `);
  }
  console.log();
}
const mapOf = async (sql, key = 'k', value = 'v') =>
  new Map((await db.query(sql)).rows.map((r) => [String(r[key]), r[value]]));

async function setupTable() {
  if (target === 'aws') {
    const t = await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
    if (t.Table.TableStatus !== 'ACTIVE') throw new Error('La tabla no está activa');
    console.log(`Tabla AWS ${t.Table.TableArn} (${t.Table.ItemCount} ítems). Sin recrear.`);
    return;
  }
  try {
    await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
    await ddb.send(new DeleteTableCommand({ TableName: TABLE }));
  } catch {}
  await ddb.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map((n) => ({
        AttributeName: n,
        AttributeType: 'S',
      })),
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: GSI2_ATTRIBUTES },
        },
      ],
    }),
  );
  await waitUntilTableExists({ client: ddb, maxWaitTime: 60 }, { TableName: TABLE });
  await ddb.send(
    new UpdateTimeToLiveCommand({
      TableName: TABLE,
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    }),
  );
}

const t0 = Date.now();
await db.connect();
await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
await setupTable();

// Contador de IDs: continúa api_entity_id_seq. En AWS no pisa uno existente.
const seq = (await db.query('SELECT last_value,is_called FROM api_entity_id_seq')).rows[0];
const counter = BigInt(seq.last_value) - (seq.is_called ? 0n : 1n);
try {
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: 'COUNTER', SK: 'ID', type: 'COUNTER', n: Number(counter) },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
} catch (e) {
  if (e.name !== 'ConditionalCheckFailedException') throw e;
  console.log('COUNTER ya existía: se conserva');
}

await stream(
  'users',
  'SELECT x.id::text, x.email, x.full_name, x.phone, x.role, x.created_at FROM users x WHERE $WHERE',
  (r) => [
    clean({
      PK: `USER#${r.id}`,
      SK: 'PROFILE',
      type: 'USER',
      userId: r.id,
      email: r.email,
      fullName: r.full_name,
      phone: r.phone,
      role: r.role,
      createdAt: iso(r.created_at),
    }),
    ...(r.email
      ? [{ PK: `EMAIL#${r.email.toLowerCase()}`, SK: 'EMAIL', type: 'EMAIL', userId: r.id }]
      : []),
  ],
);
await stream(
  'addresses',
  'SELECT x.id::text, x.user_id::text, x.street, x.city, x.country, x.postal_code FROM addresses x WHERE $WHERE',
  (r) => [
    clean({
      PK: `USER#${r.user_id}`,
      SK: `ADDR#${pad(r.id)}`,
      type: 'ADDRESS',
      addressId: r.id,
      street: r.street,
      city: r.city,
      country: r.country,
      postalCode: r.postal_code,
    }),
  ],
);
// Carrito de la API: un ítem USER#/CART con version e items [{variant_id, quantity}].
// Se toma el carrito más reciente de cada usuario; variantes repetidas se suman (máx. 50).
await stream(
  'carts',
  `SELECT x.id::text, x.user_id::text, x.updated_at,
    coalesce((SELECT json_agg(json_build_object('variant_id', ci.variant_id::text, 'quantity', least(sum_q, 1000)) ORDER BY ci.variant_id)
      FROM (SELECT variant_id, sum(quantity) AS sum_q FROM cart_items WHERE cart_id = x.id GROUP BY variant_id LIMIT 50) ci), '[]') AS items
   FROM (SELECT DISTINCT ON (user_id) id, user_id, updated_at FROM carts ORDER BY user_id, updated_at DESC NULLS LAST, id DESC) x WHERE $WHERE`,
  (r) => [
    clean({
      PK: `USER#${r.user_id}`,
      SK: 'CART',
      type: 'CART',
      version: 0,
      items: r.items.map((i) => ({ variant_id: i.variant_id, quantity: Number(i.quantity) })),
      updatedAt: iso(r.updated_at),
    }),
  ],
);
await stream(
  'orders',
  'SELECT x.id::text, x.user_id::text, x.address_id::text, x.status, x.currency, x.total_cents::text, x.customer_email_snapshot, x.created_at FROM orders x WHERE $WHERE',
  (r) => {
    const base = {
      orderId: r.id,
      userId: r.user_id,
      status: r.status,
      currency: r.currency,
      totalCents: r.total_cents,
      createdAt: iso(r.created_at),
    };
    return [
      clean({
        PK: `USER#${r.user_id}`,
        SK: `ORDER#${iso(r.created_at)}#${pad(r.id)}`,
        type: 'ORDER_SUMMARY',
        ...base,
      }),
      clean({
        PK: `ORDER#${r.id}`,
        SK: 'META',
        type: 'ORDER',
        ...base,
        addressId: r.address_id,
        customerEmail: r.customer_email_snapshot,
      }),
    ];
  },
);
await stream(
  'order_items',
  'SELECT x.id::text, x.order_id::text, x.variant_id::text, x.product_name_snapshot, x.quantity, x.unit_price_cents::text FROM order_items x WHERE $WHERE',
  (r) => [
    clean({
      PK: `ORDER#${r.order_id}`,
      SK: `ITEM#${pad(r.id)}`,
      type: 'ORDER_ITEM',
      orderItemId: r.id,
      variantId: r.variant_id,
      productName: r.product_name_snapshot,
      quantity: r.quantity,
      unitPriceCents: r.unit_price_cents,
    }),
  ],
);
await stream(
  'order_status_history',
  'SELECT x.id::text, x.order_id::text, x.status, x.created_at FROM order_status_history x WHERE $WHERE',
  (r) => [
    clean({
      PK: `ORDER#${r.order_id}`,
      SK: `STATUS#${iso(r.created_at)}#${pad(r.id)}`,
      type: 'ORDER_STATUS',
      status: r.status,
      createdAt: iso(r.created_at),
    }),
  ],
);

// Métricas del catálogo precalculadas (mismas fórmulas que api/src/catalog.ts).
console.log('Calculando métricas de catálogo...');
const stock = await mapOf(
  'SELECT v.product_id AS k, json_build_object($$min$$, min(v.price_cents)::text, $$avail$$, (SELECT coalesce(sum(greatest(coalesce(i.quantity-i.reserved,0),0)),0) FROM inventory i JOIN product_variants v2 ON v2.id=i.variant_id WHERE v2.product_id=v.product_id)::text) AS v FROM product_variants v GROUP BY v.product_id',
);
const ratings = await mapOf(
  'SELECT product_id AS k, json_build_object($$rating$$, round(avg(rating),2)::text, $$count$$, count(*)::text) AS v FROM reviews GROUP BY product_id',
);
const sold = await mapOf(
  "SELECT v.product_id AS k, sum(i.quantity)::text AS v FROM order_items i JOIN orders o ON o.id=i.order_id AND o.status IN ('paid','shipped','delivered') JOIN product_variants v ON v.id=i.variant_id GROUP BY v.product_id",
);
const views = await mapOf(
  "SELECT product_id AS k, count(*)::text AS v FROM browsing_events WHERE event_type='view' AND product_id IS NOT NULL GROUP BY product_id",
);
const catalog = (
  await db.query(
    "SELECT id::text, name, base_price_cents::text, category_id::text FROM products WHERE status='active' ORDER BY products.id",
  )
).rows;
const relatedByCategory = new Map();
for (const p of catalog) {
  const list = relatedByCategory.get(p.category_id) ?? [];
  if (list.length < 5) list.push({ id: p.id, name: p.name, base_price_cents: p.base_price_cents });
  relatedByCategory.set(p.category_id, list);
}

await stream(
  'products',
  `SELECT x.id::text, x.brand_id::text, x.category_id::text, x.name, x.description, x.base_price_cents::text, x.status, x.created_at,
    c.name AS category_name, b.name AS brand_name, se.name AS seller_name,
    (SELECT coalesce(json_agg(r ORDER BY r.created_at DESC, r.id DESC), '[]') FROM (
       SELECT r.id::text AS id, r.rating, r.title, r.body, u.full_name AS author, r.created_at
       FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=x.id ORDER BY r.created_at DESC, r.id DESC LIMIT 12) r) AS reviews
   FROM products x JOIN categories c ON c.id=x.category_id JOIN brands b ON b.id=x.brand_id JOIN sellers se ON se.id=x.seller_id WHERE $WHERE`,
  (r) => {
    const st = stock.get(r.id);
    const rt = ratings.get(r.id);
    return [
      clean({
        PK: `PRODUCT#${r.id}`,
        SK: 'META',
        type: 'PRODUCT',
        productId: r.id,
        brandId: r.brand_id,
        categoryId: r.category_id,
        name: r.name,
        description: r.description,
        basePriceCents: r.base_price_cents,
        status: r.status,
        createdAt: iso(r.created_at),
        categoryName: r.category_name,
        brandName: r.brand_name,
        sellerName: r.seller_name,
        priceCents: st?.min ?? r.base_price_cents,
        availableUnits: Number(st?.avail ?? 0),
        rating: rt?.rating,
        reviewCount: rt?.count ?? '0',
        soldUnits: sold.get(r.id) ?? '0',
        views: views.get(r.id) ?? '0',
        reviews: r.reviews.map(({ created_at, ...review }) => review),
        related: (relatedByCategory.get(r.category_id) ?? [])
          .filter((p) => p.id !== r.id)
          .slice(0, 4),
        GSI1PK: `CAT#${r.category_id}`,
        GSI1SK: `PRODUCT#${r.name}#${pad(r.id)}`,
        ...(r.status === 'active' && ++activeProducts
          ? { GSI2PK: 'CATALOG', GSI2SK: popularKey(sold.get(r.id) ?? '0', r.id) }
          : {}),
      }),
    ];
  },
);
await stream(
  'product_variants',
  `SELECT x.id::text, x.product_id::text, x.sku, x.color, x.size, x.price_cents::text,
    (SELECT coalesce(sum(greatest(i.quantity - i.reserved, 0)), 0)::int FROM inventory i WHERE i.variant_id = x.id) AS stock
   FROM product_variants x WHERE $WHERE`,
  (r) => [
    clean({
      PK: `PRODUCT#${r.product_id}`,
      SK: `VARIANT#${pad(r.id)}`,
      type: 'VARIANT',
      variantId: r.id,
      productId: r.product_id,
      sku: r.sku,
      color: r.color,
      size: r.size,
      priceCents: r.price_cents,
      stock: r.stock,
    }),
    {
      PK: `VARIANT#${r.id}`,
      SK: 'META',
      type: 'VARIANT_REF',
      variantId: r.id,
      productId: r.product_id,
    },
  ],
);
// Filtros con conteo de productos activos y orden de PostgreSQL (rank).
const cats = (
  await db.query(
    "SELECT c.id::text, c.name, c.parent_id::text, count(p.id)::text AS products, row_number() OVER (ORDER BY c.name) AS rank FROM categories c LEFT JOIN products p ON p.category_id=c.id AND p.status='active' GROUP BY c.id ORDER BY c.name",
  )
).rows;
const brands = (
  await db.query(
    "SELECT b.id::text, b.name, count(p.id)::text AS products, row_number() OVER (ORDER BY b.name) AS rank FROM brands b LEFT JOIN products p ON p.brand_id=b.id AND p.status='active' GROUP BY b.id ORDER BY b.name",
  )
).rows;
await writeAll([
  {
    PK: 'FILTERS',
    SK: 'STATS',
    type: 'STATS',
    activeProducts,
    updatedAt: new Date().toISOString(),
  },
  ...cats.map((c) =>
    clean({
      PK: 'FILTERS',
      SK: `CAT#${c.id}`,
      type: 'FILTER_CATEGORY',
      categoryId: c.id,
      name: c.name,
      parentId: c.parent_id,
      products: c.products,
      rank: Number(c.rank),
    }),
  ),
  ...brands.map((b) =>
    clean({
      PK: 'FILTERS',
      SK: `BRAND#${b.id}`,
      type: 'FILTER_BRAND',
      brandId: b.id,
      name: b.name,
      products: b.products,
      rank: Number(b.rank),
    }),
  ),
]);

await db.query('COMMIT');
await db.end();
console.log(
  `Destino: ${target === 'aws' ? 'AWS ' + (process.env.AWS_REGION ?? 'us-east-2') : ENDPOINT}, tabla ${TABLE}`,
);
console.log('Items escritos por tipo:', counts);
console.log(`Tiempo: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
