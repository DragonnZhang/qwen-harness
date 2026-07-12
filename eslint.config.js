// @ts-check
/**
 * ESLint 9 flat config.
 *
 * The rules enabled as errors here are not style: they are the correctness and security
 * properties the spec leans on. `no-unsafe-*` keeps `unknown` from silently becoming `any` at a
 * trust boundary (model output, tool arguments, config files, IPC frames). `no-floating-promises`
 * and `no-misused-promises` keep an unawaited promise from turning a failed write into a silent
 * success. `no-console` keeps library packages from printing — only apps and scripts own stdout.
 *
 * Type-aware linting uses `projectService`, so each file is checked against the tsconfig that
 * actually owns it. Test files are deliberately excluded from every package tsconfig, so they are
 * linted without type information and the type-aware rules are turned off for them.
 */

import tseslintPlugin from '@typescript-eslint/eslint-plugin';
import tseslintParser from '@typescript-eslint/parser';

const SOURCE_FILES = ['packages/**/src/**/*.ts', 'apps/**/src/**/*.ts', 'scripts/**/*.ts'];
const TEST_FILES = ['**/*.test.ts'];

/** The plugin's flat presets are unscoped; pin each one to the files we own. */
const scoped = (configs) =>
  configs.map((config) => ({
    ...config,
    files: SOURCE_FILES,
  }));

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'coverage/**', '**/coverage/**'],
  },

  ...scoped([
    ...tseslintPlugin.configs['flat/recommended'],
    ...tseslintPlugin.configs['flat/recommended-type-checked'],
  ]),

  {
    files: SOURCE_FILES,
    languageOptions: {
      parser: tseslintParser,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        projectService: {
          // `scripts/` is tooling, not a workspace package, so no tsconfig includes it. Type it
          // against the shared base config rather than an inferred project, otherwise the default
          // project has no `lib` and modern builtins degrade to `any`, producing false `no-unsafe-*`.
          allowDefaultProject: ['scripts/*.ts'],
          defaultProject: 'tsconfig.base.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A trust boundary that returns `any` is not a boundary.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // An unawaited promise is a lost error.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Libraries do not own stdout.
      'no-console': 'error',

      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    // Apps are the composition root and scripts are gates: printing is their job.
    files: ['apps/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // Tests construct malformed input on purpose, and no tsconfig includes them, so they are
    // linted without type information.
    files: TEST_FILES,
    languageOptions: {
      parser: tseslintParser,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        projectService: false,
        project: false,
      },
    },
    plugins: {
      '@typescript-eslint': tseslintPlugin,
    },
    rules: {
      ...tseslintPlugin.configs['flat/disable-type-checked'].rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-console': 'off',
    },
  },
];
