// Preparación explícita del VPS de laboratorio existente. Nunca abre PostgreSQL a Internet.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';

const host = '45.76.177.4';
const folder = 'deploy/secrets';
const key = `${folder}/lambda-db-ed25519`;
const ssh = (command, input) =>
  execFileSync(
    'ssh',
    [
      '-i',
      '/home/leandro/.ssh/id_ed25519_vultr_lab',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=15',
      `root@${host}`,
      command,
    ],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();

await mkdir(folder, { recursive: true, mode: 0o700 });
try {
  await access(key);
} catch {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'nexo-lambda-db', '-f', key]);
}
const publicKey = (await readFile(`${key}.pub`, 'utf8')).trim();
if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ nexo-lambda-db$/.test(publicKey)) {
  throw Error('Formato inesperado de clave pública');
}
ssh(
  'bash -se',
  `
id nexo-lambda >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin nexo-lambda
install -d -m 700 -o nexo-lambda -g nexo-lambda /home/nexo-lambda/.ssh
cat > /home/nexo-lambda/.ssh/authorized_keys <<'KEY'
restrict,port-forwarding,permitopen="127.0.0.1:5433" ${publicKey}
KEY
chown nexo-lambda:nexo-lambda /home/nexo-lambda/.ssh/authorized_keys
chmod 600 /home/nexo-lambda/.ssh/authorized_keys
cat > /etc/ssh/sshd_config.d/80-nexo-lambda.conf <<'CONFIG'
Match User nexo-lambda
  AllowTcpForwarding local
  PermitOpen 127.0.0.1:5433
  PermitTTY no
  AllowAgentForwarding no
  X11Forwarding no
  PasswordAuthentication no
  ForceCommand /usr/sbin/nologin
Match all
CONFIG
/usr/sbin/sshd -t
systemctl reload ssh
`,
);
const hostPublicKey = ssh('cat /etc/ssh/ssh_host_ed25519_key.pub').split(' ')[1];
const fingerprint = createHash('sha256').update(Buffer.from(hostPublicKey, 'base64')).digest('hex');
let password;
try {
  password = new URL(JSON.parse(await readFile(`${folder}/database.json`, 'utf8')).databaseUrl)
    .password;
} catch {
  password = randomBytes(32).toString('base64url');
}
if (!/^[A-Za-z0-9_-]+$/.test(password)) throw Error('Formato de contraseña inválido');
const sql = [
  await readFile('sql/006-storefront.sql', 'utf8'),
  await readFile('sql/007-auth.sql', 'utf8'),
  `DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='nexo_lambda')
    THEN CREATE ROLE nexo_lambda LOGIN; END IF; END $$;
  ALTER ROLE nexo_lambda PASSWORD '${password}' CONNECTION LIMIT 30;
  GRANT CONNECT ON DATABASE ecommerce_lab TO nexo_lambda;
  GRANT USAGE ON SCHEMA public TO nexo_lambda;
  GRANT SELECT ON products,product_variants,categories,brands,sellers,inventory,reviews,
    browsing_events,users,addresses,orders,order_items,order_status_history,store_carts,
    store_checkouts,store_accounts,store_sessions,store_auth_limits TO nexo_lambda;
  GRANT INSERT ON users,addresses,orders,order_items,order_status_history,store_carts,
    store_checkouts,store_accounts,store_sessions,store_auth_limits TO nexo_lambda;
  GRANT UPDATE ON users,inventory,store_carts,store_auth_limits TO nexo_lambda;
  GRANT DELETE ON store_sessions TO nexo_lambda;
  GRANT USAGE,SELECT ON SEQUENCE api_entity_id_seq TO nexo_lambda;`,
].join('\n');
ssh(
  'docker exec -i ecommerce-remote-postgres-1 psql -X -q -v ON_ERROR_STOP=1 -U lab -d ecommerce_lab',
  sql,
);
await writeFile(
  `${folder}/database.json`,
  JSON.stringify({
    databaseUrl: `postgres://nexo_lambda:${password}@127.0.0.1:5433/ecommerce_lab`,
    sshHost: host,
    sshUser: 'nexo-lambda',
    sshPrivateKey: await readFile(key, 'utf8'),
    sshHostKeySha256: fingerprint,
  }),
  { mode: 0o600 },
);
console.log(
  'VPS preparado: usuario SSH limitado, migraciones 006/007 y rol PostgreSQL de la tienda. Secreto local privado.',
);
