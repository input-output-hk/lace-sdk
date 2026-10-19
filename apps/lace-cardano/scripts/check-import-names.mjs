// Refuses a dependency that the inlined sources import under two local names.
// The bundler names a shared external import after whichever importing module
// it processes first, which varies between runs, so two names make the build
// alternate between two outputs and the public repository's rebuild differ
// from this one's.
import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const sourceRoots = [
  ...fs
    .readdirSync(path.join(repositoryRoot, 'packages/lib'))
    .filter(name => name.startsWith('cardano-'))
    .map(name => path.join('packages/lib', name, 'src')),
  'packages/lib/util/src/common',
];
// A default import and a namespace import are separate bindings, so each kind
// is held to one name on its own.
const IMPORT =
  /^import\s+(\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+'([^'.@][^']*|@(?!lace-lib\/)[^']*)'/gm;

const names = new Map();
for (const root of sourceRoots) {
  const directory = path.join(repositoryRoot, root);
  if (!fs.existsSync(directory)) continue;
  for (const file of fs.readdirSync(directory, { recursive: true })) {
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    for (const [, namespace, local, specifier] of source.matchAll(IMPORT)) {
      const key = `${namespace ? 'import * from' : 'default of'} ${specifier}`;
      const entry = names.get(key) ?? new Map();
      entry.set(local, path.join(root, file));
      names.set(key, entry);
    }
  }
}

const conflicts = [...names].filter(([, locals]) => locals.size > 1);
if (conflicts.length > 0) {
  // eslint-disable-next-line no-console -- the check's verdict
  console.error(
    `Import each dependency under one local name, or the build is not reproducible:\n${conflicts
      .map(
        ([specifier, locals]) =>
          `  ${specifier}: ${[...locals]
            .map(([local, file]) => `${local} (${file})`)
            .join(', ')}`,
      )
      .join('\n')}`,
  );
  process.exit(1);
}
