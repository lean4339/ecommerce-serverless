import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Client } from 'ssh2';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createPool } from '../db.js';

export type DatabaseSecret = {
  databaseUrl: string;
  sshHost: string;
  sshUser: string;
  sshPrivateKey: string;
  sshHostKeySha256: string;
};

// Puente exclusivo del laboratorio: PostgreSQL permanece privado en el VPS.
// Cada conexión del pool viaja cifrada por SSH, con una clave de acceso limitada
// a 127.0.0.1:5433. Ninguna Lambda depende del túnel de nuestra computadora.
export async function createTunnelPool(secret: DatabaseSecret) {
  if (!/^[a-f0-9]{64}$/.test(secret.sshHostKeySha256)) {
    throw new Error('Falta la huella verificada del servidor SSH');
  }
  const server = createServer((socket) => {
    const ssh = new Client();
    const fail = () => socket.destroy();
    socket.on('error', () => ssh.end());
    socket.on('close', () => ssh.end());
    ssh.on('error', fail);
    ssh.on('close', fail);
    ssh.on('ready', () => {
      ssh.forwardOut('127.0.0.1', 0, '127.0.0.1', 5433, (error, channel) => {
        if (error || socket.destroyed) {
          channel?.destroy();
          ssh.end();
          socket.destroy();
          return;
        }
        channel.on('error', fail);
        channel.on('close', fail);
        socket.pipe(channel).pipe(socket);
      });
    });
    ssh.connect({
      host: secret.sshHost,
      username: secret.sshUser,
      privateKey: secret.sshPrivateKey,
      hostHash: 'sha256',
      hostVerifier: (hash: string) => hash === secret.sshHostKeySha256,
      algorithms: { serverHostKey: ['ssh-ed25519'] },
      readyTimeout: 8000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 2,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = new URL(secret.databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  const pool = createPool(url.toString(), 10000);
  const end = pool.end.bind(pool);
  pool.end = async () => {
    await end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return pool;
}

export async function createRuntimePool() {
  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!secretArn) {
    return createPool();
  }
  const secrets = new SecretsManagerClient({});
  try {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const secret = JSON.parse(result.SecretString ?? '{}') as DatabaseSecret;
    if (!secret.databaseUrl || !secret.sshHost || !secret.sshUser || !secret.sshPrivateKey) {
      throw new Error('Configuración de base incompleta');
    }
    return await createTunnelPool(secret);
  } finally {
    secrets.destroy();
  }
}
