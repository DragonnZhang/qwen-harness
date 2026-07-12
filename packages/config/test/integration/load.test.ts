/**
 * Integration: real JSON files on a real filesystem, across every scope, resolved end to end.
 * Proves that provenance points at the actual path a value came from, that a missing file
 * contributes nothing, and that a malformed file is a typed error that NAMES the file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigFileError,
  computeConfigPaths,
  loadConfigSources,
  provenanceOf,
  resolveConfig,
} from '../../src/index.ts';

let root: string;
let projectRoot: string;
let homeDir: string;
let managedPath: string;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

function options() {
  return { projectRoot, homeDir, managedPath, env: {} as Record<string, string | undefined> };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qh-config-'));
  projectRoot = join(root, 'project');
  homeDir = join(root, 'home');
  managedPath = join(root, 'etc', 'managed.json');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loading real files across scopes', () => {
  it('resolves precedence and attributes each value to its real file path', () => {
    const paths = computeConfigPaths(options());
    writeJson(paths.user, { model: 'from-user', reasoningEffort: 'low' });
    writeJson(paths.sharedProject, { reasoningEffort: 'medium', transport: 'chat' });
    writeJson(paths.localProject, { reasoningEffort: 'high' });

    const { sources } = loadConfigSources(options());
    const resolved = resolveConfig(sources);

    // reasoningEffort set in user, shared, local -> local-project wins.
    expect(resolved.reasoningEffort.value).toBe('high');
    expect(resolved.reasoningEffort.source.scope).toBe('local-project');
    expect(resolved.reasoningEffort.source.origin).toEqual({
      kind: 'file',
      path: paths.localProject,
    });

    // model only in user; transport only in shared.
    expect(resolved.model.value).toBe('from-user');
    expect(provenanceOf(resolved, 'model')).toMatchObject({ kind: 'value', value: 'from-user' });
    expect(resolved.transport.value).toBe('chat');
    expect(resolved.transport.source.scope).toBe('shared-project');
  });

  it('a managed file on disk caps authority and is attributed to its path', () => {
    const paths = computeConfigPaths(options());
    writeJson(managedPath, { maxProfile: 'ask', networkAllowed: false, deny: ['host:metadata'] });
    writeJson(paths.localProject, {
      permissionProfile: 'yolo',
      network: true,
      deny: ['path:.git'],
    });

    const resolved = resolveConfig(loadConfigSources(options()).sources);
    expect(resolved.permissionProfile.value).toBe('ask');
    expect(resolved.permissionProfile.source.origin).toEqual({ kind: 'file', path: managedPath });
    expect(resolved.network.value).toBe(false);
    // deny-first: both the managed and project denies survive.
    expect(new Set(resolved.deny.value)).toEqual(new Set(['host:metadata', 'path:.git']));
  });

  it('a missing file contributes nothing (no source, no error)', () => {
    const paths = computeConfigPaths(options());
    writeJson(paths.user, { model: 'only-user' });
    // No shared, local, managed, or env files exist.

    const { sources } = loadConfigSources(options());
    expect(sources.map((s) => s.scope)).toEqual(['user']);

    const resolved = resolveConfig(sources);
    expect(resolved.model.value).toBe('only-user');
    // Everything unset falls back to builtin.
    expect(resolved.transport.source.scope).toBe('builtin');
    expect(resolved.permissionProfile.value).toBe('ask');
  });

  it('an empty option set with no files at all resolves entirely from builtins', () => {
    const resolved = resolveConfig(loadConfigSources(options()).sources);
    expect(resolved.model.value).toBe('qwen3.7-max');
    expect(resolved.budgets.turnsPerGoal.value).toBe(200);
    expect(resolved.budgets.turnsPerGoal.source.scope).toBe('builtin');
  });

  it('malformed JSON is a typed error that names the file', () => {
    const paths = computeConfigPaths(options());
    mkdirSync(join(paths.sharedProject, '..'), { recursive: true });
    writeFileSync(paths.sharedProject, '{ this is not json ', 'utf8');

    try {
      loadConfigSources(options());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigFileError);
      expect((err as ConfigFileError).path).toBe(paths.sharedProject);
      expect((err as ConfigFileError).reason).toBe('parse');
      expect((err as ConfigFileError).message).toContain(paths.sharedProject);
    }
  });

  it('a schema-invalid file is a typed error naming the file and stage', () => {
    const paths = computeConfigPaths(options());
    writeJson(paths.user, { apiKeyEnv: 'sk-a-raw-key-value' });

    try {
      loadConfigSources(options());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigFileError);
      expect((err as ConfigFileError).path).toBe(paths.user);
      expect((err as ConfigFileError).reason).toBe('schema');
    }
  });

  it('a v0 file on disk is migrated then resolved', () => {
    const paths = computeConfigPaths(options());
    // No `version` -> v0; legacy keys migrate forward before validation.
    writeJson(paths.user, { endpoint: 'https://legacy.example/v1', profile: 'acceptEdits' });

    const resolved = resolveConfig(loadConfigSources(options()).sources);
    expect(resolved.baseUrl.value).toBe('https://legacy.example/v1');
    expect(resolved.permissionProfile.value).toBe('auto-accept-edits');
  });
});
