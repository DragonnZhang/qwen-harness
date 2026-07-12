/**
 * Generates package.json + tsconfig.json for every workspace package from ONE declaration
 * of the layered dependency graph. The same declaration is the input to `pnpm architecture`,
 * so the manifests and the enforced boundary can never drift apart.
 *
 * Run: node --experimental-strip-types scripts/gen-packages.ts
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { LAYERS, PACKAGE_DEPS, type PackageName } from './graph.ts';

const ROOT = join(import.meta.dirname, '..');

function locate(name: PackageName): string {
  return LAYERS.apps.includes(name as never) ? `apps/${name}` : `packages/${name}`;
}

for (const [name, deps] of Object.entries(PACKAGE_DEPS) as [PackageName, PackageName[]][]) {
  const dir = join(ROOT, locate(name));
  mkdirSync(join(dir, 'src'), { recursive: true });

  const isApp = LAYERS.apps.includes(name as never);
  const scoped = `@qwen-harness/${name}`;

  const pkg: Record<string, unknown> = {
    name: scoped,
    version: '0.1.0',
    private: true,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      // A focused public API per package. Deep imports are not reachable, which is half of
      // how the architecture boundary is enforced (the other half is the architecture test).
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
    scripts: {
      build: 'tsc --build',
      clean: 'rm -rf dist *.tsbuildinfo',
    },
    dependencies: Object.fromEntries(deps.map((d) => [`@qwen-harness/${d}`, 'workspace:*'])),
  };

  if (isApp) {
    pkg['bin'] = {
      [`qwen-harness${name === 'cli' ? '' : `-${name}`}`]: './dist/bin.js',
    };
  }

  const pkgPath = join(dir, 'package.json');
  const existing = existsSync(pkgPath)
    ? (JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>)
    : {};
  // Preserve hand-added external dependencies; regenerate only the workspace wiring.
  const externalDeps = Object.fromEntries(
    Object.entries((existing['dependencies'] as Record<string, string>) ?? {}).filter(
      ([k]) => !k.startsWith('@qwen-harness/'),
    ),
  );
  pkg['dependencies'] = { ...externalDeps, ...(pkg['dependencies'] as object) };

  // Every package gets testkit as a DEV dependency so its tests can use the deterministic fakes.
  // It is never a runtime dependency: `pnpm architecture` fails the build if any `src/` file
  // imports it, which is what keeps test scaffolding out of the shipped product.
  //
  // Exception: a package that testkit itself depends on must NOT get testkit back, or the
  // workspace graph gains a cycle (pnpm warns, and `tsc --build` would eventually deadlock on it).
  // Excluding them by construction is better than discovering the cycle later.
  const testkitDeps = new Set<string>(PACKAGE_DEPS.testkit);
  const existingDev = (existing['devDependencies'] as Record<string, string>) ?? {};
  const devDeps: Record<string, string> = { ...existingDev };
  if (name !== 'testkit' && !testkitDeps.has(name)) {
    devDeps['@qwen-harness/testkit'] = 'workspace:*';
  } else {
    delete devDeps['@qwen-harness/testkit'];
  }
  if (Object.keys(devDeps).length > 0) pkg['devDependencies'] = devDeps;
  else delete pkg['devDependencies'];

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const tsconfig = {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      outDir: './dist',
      rootDir: './src',
      tsBuildInfoFile: './dist/.tsbuildinfo',
    },
    include: ['src/**/*'],
    exclude: ['src/**/*.test.ts', 'dist'],
    references: deps.map((d) => ({ path: `../../${locate(d)}` })),
  };
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');
}

// Root solution tsconfig references every package so `tsc --build` walks the whole graph.
const all = (Object.keys(PACKAGE_DEPS) as PackageName[]).map((n) => ({
  path: `./${locate(n)}`,
}));
writeFileSync(
  join(ROOT, 'tsconfig.json'),
  JSON.stringify({ files: [], references: all }, null, 2) + '\n',
);

console.log(`generated ${Object.keys(PACKAGE_DEPS).length} package manifests`);
