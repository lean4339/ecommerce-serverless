// Backfill de GSI2 (catálogo en orden "popular") sobre una tabla existente.
// Solo UpdateItem sobre PRODUCT#<id>/META (condición attribute_exists) y un Put de FILTERS/STATS.
// No recrea la tabla ni borra nada. Uso:
//   node scripts/backfill-gsi2.mjs                    -> DynamoDB Local (crea GSI2 si falta)
//   node scripts/backfill-gsi2.mjs --target aws --yes -> tabla real (GSI2 lo crea CloudFormation)
import { createRequire } from 'node:module';
import os from 'node:os';
const require = createRequire(
  `${process.env.MIGRATION_DEPS ?? os.homedir() + '/nexo-dynamo-migration'}/package.json`,
);
const {
  DynamoDBClient,
  DescribeTableCommand,
  UpdateTableCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  PutCommand,
} = require('@aws-sdk/lib-dynamodb');

const args = process.argv.slice(2);
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'local';
if (target === 'aws' && !args.includes('--yes')) throw new Error('Para AWS agregá --yes');
const TABLE = process.env.TABLE_NAME ?? 'nexo';
const CONC = Number(process.env.BACKFILL_CONCURRENCY ?? 10);
const ddb =
  target === 'local'
    ? new DynamoDBClient({
        endpoint: process.env.DYNAMO_ENDPOINT ?? 'http://127.0.0.1:8000',
        region: 'us-east-1',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      })
    : new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-2', maxAttempts: 10 });
const doc = DynamoDBDocumentClient.from(ddb);
export const pad = (id) => String(id).padStart(19, '0');
// Igual que api/src/shared/dynamo.ts: ventas invertidas para ordenar DESC con un Query ascendente.
export const popularKey = (sold, id) =>
  `${String(10n ** 15n - BigInt(sold ?? 0)).padStart(16, '0')}#${pad(id)}`;

const index = async () =>
  (
    await ddb.send(new DescribeTableCommand({ TableName: TABLE }))
  ).Table.GlobalSecondaryIndexes?.find((i) => i.IndexName === 'GSI2');
if (!(await index())) {
  if (target !== 'local') throw new Error('GSI2 no existe: desplegá primero la plantilla');
  await ddb.send(
    new UpdateTableCommand({
      TableName: TABLE,
      AttributeDefinitions: ['GSI2PK', 'GSI2SK'].map((n) => ({
        AttributeName: n,
        AttributeType: 'S',
      })),
      GlobalSecondaryIndexUpdates: [
        {
          Create: {
            IndexName: 'GSI2',
            KeySchema: [
              { AttributeName: 'GSI2PK', KeyType: 'HASH' },
              { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
            ],
            Projection: {
              ProjectionType: 'INCLUDE',
              NonKeyAttributes: [
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
              ],
            },
          },
        },
      ],
    }),
  );
  console.log('GSI2 creado en DynamoDB Local');
}
for (let i = 0; (await index()).IndexStatus !== 'ACTIVE'; i++) {
  if (i % 6 === 0) console.log('Esperando GSI2 ACTIVE...');
  await new Promise((r) => setTimeout(r, 5000));
}

const t0 = Date.now();
const categories = [];
let key;
do {
  const r = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :c)',
      ExpressionAttributeValues: { ':p': 'FILTERS', ':c': 'CAT#' },
      ExclusiveStartKey: key,
    }),
  );
  categories.push(...r.Items.map((c) => String(c.categoryId)));
  key = r.LastEvaluatedKey;
} while (key);

async function pool(items, fn) {
  let k = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (k < items.length) await fn(items[k++]);
    }),
  );
}
const products = [];
await pool(categories, async (cat) => {
  let start;
  do {
    const r = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :p',
        ExpressionAttributeValues: { ':p': `CAT#${cat}` },
        ProjectionExpression: 'productId, soldUnits, #s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExclusiveStartKey: start,
      }),
    );
    products.push(...r.Items);
    start = r.LastEvaluatedKey;
  } while (start);
});
let done = 0,
  active = 0;
await pool(products, async (p) => {
  const isActive = p.status === 'active';
  active += isActive ? 1 : 0;
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `PRODUCT#${p.productId}`, SK: 'META' },
      ConditionExpression: 'attribute_exists(PK)',
      // Solo productos activos entran al índice del catálogo.
      ...(isActive
        ? {
            UpdateExpression: 'SET GSI2PK = :pk, GSI2SK = :sk',
            ExpressionAttributeValues: {
              ':pk': 'CATALOG',
              ':sk': popularKey(p.soldUnits, p.productId),
            },
          }
        : { UpdateExpression: 'REMOVE GSI2PK, GSI2SK' }),
    }),
  );
  if (++done % 1000 === 0) process.stdout.write(`\rproductos: ${done}/${products.length}`);
});
await doc.send(
  new PutCommand({
    TableName: TABLE,
    Item: {
      PK: 'FILTERS',
      SK: 'STATS',
      type: 'STATS',
      activeProducts: active,
      updatedAt: new Date().toISOString(),
    },
  }),
);
console.log(
  `\n${target}: ${done} productos actualizados (${active} activos en GSI2) en ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
