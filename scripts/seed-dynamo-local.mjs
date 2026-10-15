// Datos sintéticos para E2E/CI en DynamoDB Local (nunca AWS). Recrea la tabla.
// 60 productos activos (3 categorías, 2 marcas), 2 variantes c/u con stock, reseñas y filtros.
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const endpoint = process.env.DYNAMO_ENDPOINT ?? 'http://127.0.0.1:8000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(endpoint)) throw new Error('Solo DynamoDB Local');
const TableName = process.env.TABLE_NAME ?? 'nexo';
const raw = new DynamoDBClient({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const doc = DynamoDBDocumentClient.from(raw);
const pad = (id) => String(id).padStart(19, '0');
const popularKey = (sold, id) =>
  `${String(10n ** 15n - BigInt(sold)).padStart(16, '0')}#${pad(id)}`;
const gsi = (n) => ({
  IndexName: n,
  KeySchema: [
    { AttributeName: `${n}PK`, KeyType: 'HASH' },
    { AttributeName: `${n}SK`, KeyType: 'RANGE' },
  ],
  Projection: { ProjectionType: 'ALL' },
});
try {
  await raw.send(new DeleteTableCommand({ TableName }));
} catch {}
await raw.send(
  new CreateTableCommand({
    TableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map((n) => ({
      AttributeName: n,
      AttributeType: 'S',
    })),
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [gsi('GSI1'), gsi('GSI2')],
  }),
);
await waitUntilTableExists({ client: raw, maxWaitTime: 30 }, { TableName });

const categories = [
  { id: '1', name: 'Cocina', parent: undefined },
  { id: '2', name: 'Hogar', parent: undefined },
  { id: '3', name: 'Mates', parent: '1' },
];
const brands = [
  { id: '1', name: 'Andina' },
  { id: '2', name: 'Pampa' },
];
const words = ['Mate', 'Termo', 'Taza', 'Bombilla', 'Yerbera', 'Mantel', 'Lámpara', 'Cuenco'];
const items = [{ PK: 'COUNTER', SK: 'ID', type: 'COUNTER', n: 1000000000000 }];
const counts = new Map();
for (let i = 1; i <= 60; i++) {
  const id = String(i);
  const cat = categories[i % 3];
  const brand = brands[i % 2];
  const name = `${words[i % words.length]} E2E ${String(i).padStart(2, '0')}`;
  const sold = (i * 37) % 50;
  const prices = [1000 + i * 100, 2000 + i * 100];
  counts.set(cat.id, (counts.get(cat.id) ?? 0) + 1);
  counts.set(`b${brand.id}`, (counts.get(`b${brand.id}`) ?? 0) + 1);
  items.push({
    PK: `PRODUCT#${id}`,
    SK: 'META',
    type: 'PRODUCT',
    productId: id,
    name,
    description: `Producto de prueba ${i} para regresión`,
    basePriceCents: String(prices[0]),
    priceCents: String(prices[0]),
    categoryId: cat.id,
    categoryName: cat.name,
    brandId: brand.id,
    brandName: brand.name,
    sellerName: 'Vendedor E2E',
    status: 'active',
    createdAt: new Date(Date.UTC(2026, 0, i)).toISOString(),
    availableUnits: 100,
    rating: i % 4 ? `${(i % 5) + 1}.00` : undefined,
    reviewCount: i % 4 ? '1' : '0',
    soldUnits: String(sold),
    views: String(i * 3),
    reviews:
      i % 4
        ? [{ id: id, rating: (i % 5) + 1, title: 'Bueno', body: 'Anda bien', author: 'Ana' }]
        : [],
    related: [],
    GSI1PK: `CAT#${cat.id}`,
    GSI1SK: `PRODUCT#${name}#${pad(id)}`,
    GSI2PK: 'CATALOG',
    GSI2SK: popularKey(sold, id),
  });
  prices.forEach((price, v) => {
    const variantId = String(i * 10 + v);
    items.push(
      {
        PK: `PRODUCT#${id}`,
        SK: `VARIANT#${pad(variantId)}`,
        type: 'VARIANT',
        variantId,
        productId: id,
        sku: `E2E-${variantId}`,
        color: v ? 'negro' : 'natural',
        size: v ? 'L' : 'M',
        priceCents: String(price),
        stock: 50,
      },
      { PK: `VARIANT#${variantId}`, SK: 'META', type: 'VARIANT_REF', variantId, productId: id },
    );
  });
}
items.push({ PK: 'FILTERS', SK: 'STATS', type: 'STATS', activeProducts: 60 });
categories.forEach((c, rank) =>
  items.push({
    PK: 'FILTERS',
    SK: `CAT#${c.id}`,
    categoryId: c.id,
    name: c.name,
    parentId: c.parent,
    products: String(counts.get(c.id) ?? 0),
    rank,
  }),
);
brands.forEach((b, rank) =>
  items.push({
    PK: 'FILTERS',
    SK: `BRAND#${b.id}`,
    brandId: b.id,
    name: b.name,
    products: String(counts.get(`b${b.id}`)),
    rank,
  }),
);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
for (let i = 0; i < items.length; i += 25) {
  await doc.send(
    new BatchWriteCommand({
      RequestItems: {
        [TableName]: items.slice(i, i + 25).map((it) => ({ PutRequest: { Item: clean(it) } })),
      },
    }),
  );
}
console.log(
  `DynamoDB Local ${endpoint}: tabla ${TableName} con ${items.length} ítems (60 productos)`,
);
