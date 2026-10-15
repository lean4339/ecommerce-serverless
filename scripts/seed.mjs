import { parseArgs } from 'node:util';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tables, profiles, counts, row, schema, loadFaker } from './model.mjs';

const { values: v } = parseArgs({
  options: {
    profile: { type: 'string', default: 'small' },
    users: { type: 'string' },
    products: { type: 'string' },
    orders: { type: 'string' },
    events: { type: 'string' },
    batch: { type: 'string', default: '5000' },
    seed: { type: 'string', default: '42' },
    'payload-bytes': { type: 'string', default: '512' },
    'message-paragraphs': { type: 'string', default: '2' },
    plan: { type: 'boolean', default: false },
    export: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});
if (v.help) {
  console.log(`npm run seed -- [--profile tiny|small|million|monster]
  [--users N --products N --orders N --events N] [--batch 5000] [--seed 42]
  [--payload-bytes 512] [--message-paragraphs 2] [--plan] [--export output.sql]
Sin --export: carga PostgreSQL usando DATABASE_URL y COPY por lotes.
Con --export: genera SQL autónomo (esquema + INSERT); importar en una DB vacía.`);
  process.exit(0);
}
const positive = (name, value, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  if (!/^\d+$/.test(String(value))) throw Error(`${name}: debe ser un entero`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error(`${name}: fuera de rango ${min}..${max}`);
  return n;
};
if (!profiles[v.profile]) throw Error('Perfil desconocido');
const base = { ...profiles[v.profile] };
for (const key of Object.keys(base))
  if (v[key] !== undefined) base[key] = positive(key, v[key], 1, 1000000000);
const options = {
  seed: positive('seed', v.seed, 0, 4294967295),
  payloadBytes: positive('payload-bytes', v['payload-bytes'], 0, 65536),
  messageParagraphs: positive('message-paragraphs', v['message-paragraphs'], 1, 100),
};
const batch = positive('batch', v.batch, 1, 100000);
const c = counts(base),
  total = Object.values(c).reduce((a, b) => a + b, 0);
console.table(tables.map((t) => ({ table: t.name, rows: c[t.name] })));
console.log(
  `Total: ${total.toLocaleString('es-AR')} filas; lote: ${batch}; semilla: ${options.seed}.`,
);
console.log(
  'El tamaño en disco depende del texto, TOAST, índices y WAL. --plan no conecta ni escribe.',
);
if (v.plan) process.exit(0);
await loadFaker();
let stopped = false;
process.on('SIGINT', () => {
  stopped = true;
  console.log('Deteniendo después del lote actual…');
});
process.on('SIGTERM', () => {
  stopped = true;
});
const literal = (x) =>
  x === null ? 'NULL' : typeof x === 'number' ? String(x) : `'${String(x).replaceAll("'", "''")}'`;
const csv = (x) => (x === null ? '' : `"${String(x).replaceAll('"', '""')}"`);
if (v.export) {
  async function* sql() {
    yield schema;
    for (const t of tables) {
      for (let start = 1; start <= c[t.name]; start += batch) {
        if (stopped)
          throw Error(
            'Exportación interrumpida: archivo parcial, no importar como dataset completo.',
          );
        yield 'BEGIN;\n';
        // INSERT más chicos para que un lote grande no construya un string gigante.
        for (let id = start; id <= Math.min(c[t.name], start + batch - 1);) {
          const rows = [];
          for (
            let n = 0;
            n < Math.min(batch, 500) && id <= Math.min(c[t.name], start + batch - 1);
            n++, id++
          )
            rows.push(`(${row(t, id, c, options).map(literal).join(',')})`);
          yield `INSERT INTO ${t.name} (${t.columns.map((x) => x.name).join(',')}) VALUES\n${rows.join(',\n')};\n`;
        }
        yield 'COMMIT;\n';
      }
      console.log(`Exportado ${t.name}: ${c[t.name]}`);
    }
  }
  await pipeline(Readable.from(sql()), createWriteStream(v.export, { flags: 'wx' }));
  console.log(`SQL exportado en ${v.export}`);
} else {
  const { default: pg } = await import('pg');
  const { from: copyFrom } = await import('pg-copy-streams');
  const client = new pg.Client({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://lab:lab_local_only@127.0.0.1:5433/ecommerce_lab',
  });
  let connected = false,
    locked = false;
  try {
    await client.connect();
    connected = true;
    const lock = await client.query('SELECT pg_try_advisory_lock(740102) AS acquired');
    if (!lock.rows[0].acquired) throw Error('Ya hay otro generador trabajando en esta base');
    locked = true;
    const generatorHash = createHash('sha256')
      .update(await readFile(new URL('./model.mjs', import.meta.url)))
      .digest('hex');
    const config = { base, options, schema, generatorHash };
    await client.query('INSERT INTO seed_runs VALUES (1,$1::jsonb) ON CONFLICT DO NOTHING', [
      JSON.stringify(config),
    ]);
    const saved = await client.query(
      'SELECT config = $1::jsonb AS matches FROM seed_runs WHERE id=1',
      [JSON.stringify(config)],
    );
    if (!saved.rows[0].matches)
      throw Error(
        'Configuración distinta a la carga anterior. Usá otra base vacía; la reanudación requiere los mismos tamaños, semilla y esquema.',
      );
    for (const t of tables) {
      const saved = await client.query('SELECT last_id FROM seed_progress WHERE table_name=$1', [
        t.name,
      ]);
      let last = Number(saved.rows[0]?.last_id ?? 0);
      if (last === 0) {
        const existing = await client.query(`SELECT EXISTS(SELECT 1 FROM ${t.name}) AS populated`);
        if (existing.rows[0].populated)
          throw Error(`${t.name} ya tiene filas sin checkpoint; no se mezclan datasets.`);
      }
      for (let start = last + 1; start <= c[t.name] && !stopped; start += batch) {
        const end = Math.min(c[t.name], start + batch - 1);
        await client.query('BEGIN');
        try {
          async function* lines() {
            for (let id = start; id <= end; id++)
              yield row(t, id, c, options).map(csv).join(',') + '\n';
          }
          const sink = client.query(
            copyFrom(
              `COPY ${t.name} (${t.columns.map((x) => x.name).join(',')}) FROM STDIN WITH (FORMAT csv)`,
            ),
          );
          await pipeline(Readable.from(lines()), sink);
          await client.query(
            'INSERT INTO seed_progress VALUES ($1,$2) ON CONFLICT (table_name) DO UPDATE SET last_id=EXCLUDED.last_id',
            [t.name, end],
          );
          await client.query('COMMIT');
          console.log(`${t.name}: ${end.toLocaleString()}/${c[t.name].toLocaleString()}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      if (stopped) break;
    }
    console.log(
      stopped
        ? 'Carga pausada. Repetí el comando para reanudar.'
        : 'Carga completa. Ejecutá npm run verify.',
    );
  } finally {
    if (connected) {
      if (locked) await client.query('SELECT pg_advisory_unlock(740102)').catch(() => {});
      await client.end();
    }
  }
}
