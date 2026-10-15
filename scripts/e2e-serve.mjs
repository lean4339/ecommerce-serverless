// Stack local para E2E: siembra DynamoDB Local y levanta la API local (handlers Lambda) + UI.
import { execFileSync, spawn } from 'node:child_process';
const port = process.env.PORT ?? '3010';
const env = {
  ...process.env,
  DATA_BACKEND: 'dynamo',
  DYNAMO_ENDPOINT: process.env.DYNAMO_ENDPOINT ?? 'http://127.0.0.1:8000',
  TABLE_NAME: process.env.TABLE_NAME ?? 'nexo-e2e',
  APP_ORIGIN: `http://127.0.0.1:${port}`,
  LOCAL_DEVELOPMENT: 'true',
  PORT: port,
};
execFileSync(process.execPath, ['scripts/seed-dynamo-local.mjs'], { env, stdio: 'inherit' });
const child = spawn(process.execPath, ['dist/src/local-api.js'], { env, stdio: 'inherit' });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
child.on('exit', (code) => process.exit(code ?? 0));
