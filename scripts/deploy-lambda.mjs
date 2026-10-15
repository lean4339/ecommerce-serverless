import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

// La configuración contiene nombres y ARN, nunca contraseñas ni claves privadas.
const config = JSON.parse(await readFile('deploy/lambda/config.json', 'utf8'));
const { profile, region, stackName, databaseSecretArn } = config;
const environment = {
  ...process.env,
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_PAGER: '',
  SAM_CLI_TELEMETRY: '0',
};
const awsArgs = ['--profile', profile, '--region', region, '--output', 'json'];
const aws = (...args) =>
  JSON.parse(execFileSync('aws', [...args, ...awsArgs], { env: environment, encoding: 'utf8' }));
const account = aws('sts', 'get-caller-identity').Account;
if (!databaseSecretArn.startsWith(`arn:aws:secretsmanager:${region}:${account}:secret:`)) {
  throw Error('El secreto no pertenece a la cuenta y región seleccionadas');
}
const deploy = (origin) =>
  execFileSync(
    'sam',
    [
      'deploy',
      '--template-file',
      'deploy/lambda/template.yaml',
      '--stack-name',
      stackName,
      '--profile',
      profile,
      '--region',
      region,
      '--resolve-s3',
      '--capabilities',
      'CAPABILITY_IAM',
      '--no-confirm-changeset',
      '--no-fail-on-empty-changeset',
      '--parameter-overrides',
      `DatabaseSecretArn=${databaseSecretArn}`,
      `AppOrigin=${origin}`,
    ],
    { env: environment, stdio: 'inherit' },
  );
const outputs = () =>
  Object.fromEntries(
    aws('cloudformation', 'describe-stacks', '--stack-name', stackName).Stacks[0].Outputs.map(
      ({ OutputKey, OutputValue }) => [OutputKey, OutputValue],
    ),
  );
execFileSync(
  'sam',
  ['validate', '--lint', '--template-file', 'deploy/lambda/template.yaml', '--region', region],
  { env: environment, stdio: 'inherit' },
);
// Primer despliegue: CloudFront elige el dominio. Segundo: habilita ese origen en el login.
let origin = config.appOrigin ?? 'https://deployment-pending.invalid';
deploy(origin);
const result = outputs();
if (origin !== result.StoreUrl) {
  origin = result.StoreUrl;
  deploy(origin);
}
await writeFile(
  'deploy/lambda/config.json',
  `${JSON.stringify({ ...config, appOrigin: origin }, null, 2)}\n`,
);
execFileSync(
  'aws',
  [
    's3',
    'sync',
    'frontend/dist/',
    `s3://${result.FrontendBucketName}/`,
    '--exclude',
    'index.html',
    '--cache-control',
    'public,max-age=31536000,immutable',
    '--profile',
    profile,
    '--region',
    region,
  ],
  { env: environment, stdio: 'inherit' },
);
execFileSync(
  'aws',
  [
    's3',
    'cp',
    'frontend/dist/index.html',
    `s3://${result.FrontendBucketName}/index.html`,
    '--content-type',
    'text/html',
    '--cache-control',
    'no-cache',
    '--profile',
    profile,
    '--region',
    region,
  ],
  { env: environment, stdio: 'inherit' },
);
aws(
  'cloudfront',
  'create-invalidation',
  '--distribution-id',
  result.DistributionId,
  '--paths',
  '/',
  '/index.html',
);
await writeFile('deploy/lambda/outputs.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(`Tienda publicada: ${result.StoreUrl}`);
console.log(
  `Logs: aws logs tail /aws/lambda/${stackName}-auth --follow --profile ${profile} --region ${region}`,
);
