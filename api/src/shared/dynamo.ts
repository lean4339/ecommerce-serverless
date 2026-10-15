import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

// Cliente creado fuera de los handlers para reutilizarse entre invocaciones.
// DYNAMO_ENDPOINT solo se usa en local (por ejemplo http://127.0.0.1:8000).
const endpoint = process.env.DYNAMO_ENDPOINT || undefined;
const client = new DynamoDBClient({
  ...(endpoint && {
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
    },
  }),
});
export const dynamo = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
export const tableName = () => process.env.TABLE_NAME ?? 'nexo';
export const useDynamo = () => process.env.DATA_BACKEND === 'dynamo';

export type DynamoItem = Record<string, unknown>;
// IDs numéricos con ancho fijo en las SK para que DynamoDB los ordene como números.
export const pad = (id: string | number) => String(id).padStart(19, '0');
export const str = (value: unknown): string | null =>
  value === undefined || value === null ? null : String(value);

export async function getItem(PK: string, SK: string): Promise<DynamoItem | undefined> {
  const { Item } = await dynamo.send(
    new GetCommand({ TableName: tableName(), Key: { PK, SK }, ConsistentRead: true }),
  );
  return Item;
}

export async function queryAll(input: Omit<QueryCommandInput, 'TableName'>) {
  const items: DynamoItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({ TableName: tableName(), ...input, ExclusiveStartKey }),
    );
    items.push(...(result.Items ?? []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export async function batchGet(keys: { PK: string; SK: string }[]): Promise<DynamoItem[]> {
  const unique = [...new Map(keys.map((k) => [`${k.PK}|${k.SK}`, k])).values()];
  const items: DynamoItem[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    let request: { Keys: Record<string, unknown>[]; ConsistentRead: boolean } | undefined = {
      Keys: unique.slice(i, i + 100),
      ConsistentRead: true,
    };
    for (let attempt = 0; request?.Keys.length; attempt++) {
      const result = await dynamo.send(
        new BatchGetCommand({ RequestItems: { [tableName()]: request } }),
      );
      items.push(...(result.Responses?.[tableName()] ?? []));
      request = result.UnprocessedKeys?.[tableName()] as typeof request;
      if (request?.Keys.length) {
        await new Promise((r) => setTimeout(r, 25 * 2 ** Math.min(attempt, 6)));
      }
    }
  }
  return items;
}

// Contador atómico: reserva `count` IDs consecutivos (mismo rango que api_entity_id_seq).
export async function nextIds(count: number): Promise<string[]> {
  const result = await dynamo.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { PK: 'COUNTER', SK: 'ID' },
      UpdateExpression: 'ADD n :count',
      ExpressionAttributeValues: { ':count': count },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const last = BigInt(String(result.Attributes!.n));
  const first = last < 1000000000000n ? null : last - BigInt(count) + 1n;
  if (first === null) {
    throw new Error('Contador de IDs no inicializado');
  }
  return Array.from({ length: count }, (_, i) => String(first + BigInt(i)));
}

export function cancellationCodes(error: unknown): string[] | undefined {
  const e = error as { name?: string; CancellationReasons?: { Code?: string }[] };
  return e?.name === 'TransactionCanceledException'
    ? (e.CancellationReasons ?? []).map((r) => r.Code ?? 'None')
    : undefined;
}
export const isConditionFailure = (error: unknown) =>
  (error as { name?: string })?.name === 'ConditionalCheckFailedException';
