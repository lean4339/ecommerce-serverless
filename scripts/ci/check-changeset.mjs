// Falla si el changeset borra recursos o reemplaza/borra la tabla NexoTable (datos de producción).
import { execFileSync } from 'node:child_process';

const arn = process.argv[2];
if (!arn) throw new Error('Uso: node scripts/ci/check-changeset.mjs <changeset-arn>');
const changes = [];
let token;
do {
  const page = JSON.parse(
    execFileSync(
      'aws',
      [
        'cloudformation',
        'describe-change-set',
        '--change-set-name',
        arn,
        '--output',
        'json',
        ...(token ? ['--next-token', token] : []),
      ],
      { encoding: 'utf8' },
    ),
  );
  changes.push(...(page.Changes ?? []));
  token = page.NextToken;
} while (token);
const problems = [];
for (const { ResourceChange: c } of changes) {
  if (!c) continue;
  const line = `${c.Action} ${c.LogicalResourceId} (${c.ResourceType}) replacement=${c.Replacement ?? '-'}`;
  console.log(line);
  if (c.Action === 'Remove') problems.push(line);
  if (
    c.LogicalResourceId === 'NexoTable' &&
    (c.Replacement === 'True' ||
      c.Replacement === 'Conditional' ||
      (c.Details ?? []).some((d) => d.Target?.RequiresRecreation === 'Always'))
  ) {
    problems.push(line);
  }
}
if (problems.length) {
  console.error('::error::Changeset peligroso, no se ejecuta:\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`OK: ${changes.length} cambios sin Remove ni reemplazo de NexoTable`);
