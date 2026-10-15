import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export async function startDatabase(name) {
  docker(
    'run',
    '--rm',
    '-d',
    '--label',
    'nexo.serverless.lab=true',
    '--name',
    name,
    '-e',
    'POSTGRES_USER=lab',
    '-e',
    'POSTGRES_PASSWORD=local_test_only',
    '-e',
    'POSTGRES_DB=ecommerce_lab',
    '-p',
    '127.0.0.1::5432',
    'postgres:17',
  );
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'lab', '-d', 'ecommerce_lab');
        ready = true;
        break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw Error('PostgreSQL local no inició');
    const port = docker('port', name, '5432/tcp').split(':').at(-1);
    const url = `postgres://lab:local_test_only@127.0.0.1:${port}/ecommerce_lab`;
    const folder = await mkdtemp(join(tmpdir(), 'nexo-seed-'));
    const db = new pg.Client({ connectionString: url });
    try {
      const file = join(folder, 'tiny.sql');
      execFileSync(process.execPath, ['scripts/seed.mjs', '--profile', 'tiny', '--export', file], {
        stdio: 'pipe',
      });
      await db.connect();
      await db.query(await readFile(file, 'utf8'));
      await db.query(await readFile('sql/006-storefront.sql', 'utf8'));
      await db.query(await readFile('sql/007-auth.sql', 'utf8'));
      await db.query(
        "UPDATE products SET status='active'; UPDATE inventory SET quantity=20,reserved=0; UPDATE users SET role='customer' WHERE id IN (1,2)",
      );
    } finally {
      await db.end();
      await rm(folder, { recursive: true, force: true });
    }
    return url;
  } catch (error) {
    stopDatabase(name);
    throw error;
  }
}
export function stopDatabase(name) {
  try {
    if (
      docker('inspect', '--format', '{{ index .Config.Labels "nexo.serverless.lab" }}', name) ===
      'true'
    )
      docker('rm', '-f', name);
  } catch {}
}
