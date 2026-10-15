import { spawn, execFileSync } from 'node:child_process';
import { startDatabase, stopDatabase } from './local-database.mjs';
const name = 'nexo-serverless-demo';
if (process.argv.includes('--stop')) {
  stopDatabase(name);
  process.exit(0);
}
let child;
const stop = () => {
  child?.kill('SIGTERM');
  stopDatabase(name);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const url = await startDatabase(name);
  for (const script of ['build', 'build:ui'])
    execFileSync('npm', ['run', script], { stdio: 'inherit' });
  console.log('Demo local con 15 productos sintéticos. No usa ni modifica la DB de Singapur.');
  child = spawn(process.execPath, ['dist/src/local-api.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: url,
      APP_ORIGIN: process.env.APP_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`,
      LOCAL_DEVELOPMENT: 'true',
      PORT: process.env.PORT ?? '3000',
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', reject);
  });
} finally {
  stopDatabase(name);
}
