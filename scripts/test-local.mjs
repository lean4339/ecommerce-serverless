import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { startDatabase, stopDatabase } from './local-database.mjs';
const name = 'nexo-lambda-test-' + randomBytes(5).toString('hex');
try {
  const url = await startDatabase(name);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--test', 'api/test/storefront.test.ts', 'api/test/auth.test.ts'],
    {
      stdio: 'inherit',
      env: { ...process.env, TEST_DATABASE_URL: url },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', reject);
  });
} finally {
  stopDatabase(name);
}
