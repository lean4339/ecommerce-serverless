import { build } from 'esbuild';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { functionNames } from '../dist/src/routes.js';

await rm('dist/functions', { recursive: true, force: true });
for (const name of functionNames) {
  const dir = `dist/functions/${name}`;
  await mkdir(dir, { recursive: true });
  const result = await build({
    entryPoints: [`api/src/functions/${name}.ts`],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: `${dir}/index.js`,
    sourcemap: true,
    metafile: true,
    external: [
      'pg-native',
      'cpu-features',
      './crypto/build/Release/sshcrypto.node',
      './build/Release/sshcrypto.node',
    ],
  });
  const inputs = Object.keys(result.metafile.inputs);
  if (inputs.some((path) => /api\/src\/functions\//.test(path) && !path.endsWith(`/${name}.ts`)))
    throw Error('Una función incluye otro handler');
  if (inputs.some((path) => /fastify|frontend|local-api/.test(path)))
    throw Error('Una función incluye el servidor local o la UI');
  await writeFile(`${dir}/package.json`, JSON.stringify({ type: 'commonjs', private: true }));
  await writeFile(`${dir}/build-inputs.json`, JSON.stringify(inputs, null, 2));
  execFileSync(
    'python3',
    [
      '-c',
      `from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import sys
folder=Path(sys.argv[1])
with ZipFile(str(folder)+'.zip','w',ZIP_DEFLATED) as z:
 for name in ['index.js','index.js.map','package.json','build-inputs.json']: z.write(folder/name,name)
print(folder.name+': '+str(Path(str(folder)+'.zip').stat().st_size)+' bytes')`,
      dir,
    ],
    { stdio: 'inherit' },
  );
}
console.log(`${functionNames.length} ZIP independientes. Ningún recurso AWS fue creado.`);
