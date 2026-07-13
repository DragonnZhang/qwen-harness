/**
 * Generates package.json + tsconfig.json for every workspace package from ONE declaration
 * of the layered dependency graph. The same declaration is the input to `pnpm architecture`,
 * so the manifests and the enforced boundary can never drift apart.
 *
 * Run: tsx scripts/gen-packages.ts
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import prettier from 'prettier';

import { LAYERS, PACKAGE_DEPS, type PackageName } from './graph.ts';

const ROOT = join(import.meta.dirname, '..');

/**
 * Write JSON the way prettier would, so `pnpm format:check` never has to re-fix a generated file.
 *
 * `JSON.stringify(v, null, 2)` and prettier disagree — prettier collapses short arrays onto one
 * line (`"include": ["src/**​/*"]`) where stringify always expands them. That disagreement made the
 * format gate fail every time this script ran, for 32 tsconfig files at once. Formatting the output
 * through prettier's own resolved config removes the disagreement at the source rather than leaving
 * a `pnpm format` chore behind every regeneration.
 */
async function writeFormattedJson(path: string, value: unknown): Promise<void> {
  const options = await prettier.resolveConfig(path);
  // The parser is inferred from `filepath`, NOT forced. Prettier applies a `json-stringify` parser
  // to `package.json` specifically (which keeps nested objects expanded) and a plain `json` parser
  // to `tsconfig.json` (which collapses short arrays). Forcing one parser gets one of them wrong —
  // that is the whole reason this used to fight the format gate. Letting prettier pick per file is
  // what makes the generated output byte-identical to what `pnpm format:check` expects.
  const formatted = await prettier.format(JSON.stringify(value), {
    ...options,
    filepath: path,
  });
  writeFileSync(path, formatted);
}

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

  // Preserve hand-authored scripts (e.g. tool-worker's esbuild bundle step). The generator only
  // guarantees `build`/`clean` EXIST; it must never clobber a package's custom build. Re-running
  // this generator used to silently strip the worker bundle build — a real hazard when several
  // agents regenerate concurrently — so existing scripts win over the defaults here.
  const existingScripts = (existing['scripts'] as Record<string, string> | undefined) ?? {};
  pkg['scripts'] = { ...(pkg['scripts'] as object), ...existingScripts };

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

  await writeFormattedJson(pkgPath, pkg);

  // Preserve hand-authored compiler options and excludes, exactly as we preserve custom scripts
  // above. This is not hypothetical: `apps/tui` needs `jsx`/`jsxImportSource`/`lib` and a `*.test.tsx`
  // exclude to compile its Ink components (ADR 0004), and a regeneration that dropped them silently
  // broke the TUI build — the source still typechecked from its own project references, but a clean
  // `pnpm build` could not compile a single `.tsx` file. The generator owns the workspace wiring
  // (`extends`, `references`, `outDir`/`rootDir`/`tsBuildInfoFile`, the base `include`); anything a
  // package added on top of that wins.
  const tsconfigPath = join(dir, 'tsconfig.json');
  const existingTsconfig = existsSync(tsconfigPath)
    ? (JSON.parse(readFileSync(tsconfigPath, 'utf8')) as Record<string, unknown>)
    : {};
  const existingCompilerOptions =
    (existingTsconfig['compilerOptions'] as Record<string, unknown> | undefined) ?? {};
  const existingExclude = (existingTsconfig['exclude'] as string[] | undefined) ?? [];

  const tsconfig = {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      // Generator-owned paths first, then any custom options the package added (custom wins).
      outDir: './dist',
      rootDir: './src',
      tsBuildInfoFile: './dist/.tsbuildinfo',
      ...Object.fromEntries(
        Object.entries(existingCompilerOptions).filter(
          ([k]) => !['outDir', 'rootDir', 'tsBuildInfoFile'].includes(k),
        ),
      ),
    },
    include: ['src/**/*'],
    // The generator guarantees these excludes exist; a package may add more (e.g. `*.test.tsx`).
    exclude: [...new Set(['src/**/*.test.ts', 'dist', ...existingExclude])],
    references: deps.map((d) => ({ path: `../../${locate(d)}` })),
  };
  await writeFormattedJson(tsconfigPath, tsconfig);
}

// Root solution tsconfig references every package so `tsc --build` walks the whole graph.
const all = (Object.keys(PACKAGE_DEPS) as PackageName[]).map((n) => ({
  path: `./${locate(n)}`,
}));
await writeFormattedJson(join(ROOT, 'tsconfig.json'), { files: [], references: all });

console.log(`generated ${Object.keys(PACKAGE_DEPS).length} package manifests`);
