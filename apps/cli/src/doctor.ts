import { join } from 'node:path';

import { loadResolvedConfig, provenanceOf } from '@qwen-harness/config';
import { detectCapability } from '@qwen-harness/sandbox-linux';
import { LATEST_SCHEMA_VERSION } from '@qwen-harness/storage';

import { loadHooks } from './hooks.ts';
import { loadGuidance } from './instructions.ts';
import { loadMcpConfiguration } from './mcp.ts';
import { createSkillSurface } from './skills.ts';
import { listTraceFiles } from './telemetry.ts';

/**
 * `doctor` — the environment report (OB-03/SB-03). It explains what the harness can and cannot do
 * on this host, and WHY, without ever printing a secret value. Credential presence is reported as
 * a boolean; the value is never read here.
 *
 * OB-03 requires it to report MCP, storage, migrations, and known degradation, which it could not
 * do while those subsystems had no composition. Now that they do, each is a line here. A degradation
 * is reported AS a degradation — a skill that failed validation, an MCP server that is configured
 * but untrusted, a hook file that will not parse — rather than omitted so the report looks clean.
 * A doctor that only prints good news is not a diagnostic.
 */
export interface DoctorReport {
  readonly lines: string[];
  /** True only when nothing blocks a safe, non-degraded run. */
  readonly healthy: boolean;
}

export function runDoctor(opts: {
  projectRoot: string;
  env: Record<string, string | undefined>;
  /** Injected, never read from the environment here. Defaults only so old callers still compile. */
  homeDir?: string;
}): DoctorReport {
  const lines: string[] = [];
  let healthy = true;

  const homeDir = opts.homeDir ?? join('/home', 'nobody');
  const degraded: string[] = [];

  lines.push('qwen-harness doctor');
  lines.push('');

  // --- platform ---
  lines.push(`platform: ${process.platform} ${process.arch}, node ${process.version}`);
  if (process.platform !== 'linux') {
    lines.push('  ✗ not Linux — this product targets Linux only');
    healthy = false;
  }

  // --- sandbox ---
  const cap = detectCapability();
  if (cap.available) {
    lines.push(`sandbox: ✓ ${cap.backend} (${cap.bwrapVersion ?? 'version unknown'})`);
  } else {
    lines.push(`sandbox: ✗ unavailable — ${cap.detail}`);
    lines.push('  a safe profile cannot run without a real sandbox; release cannot pass degraded');
    healthy = false;
  }
  for (const probe of cap.probes) {
    lines.push(`  ${probe.ok ? '·' : '✗'} ${probe.name}: ${probe.detail}`);
  }

  // --- config + provenance ---
  try {
    const { resolved } = loadResolvedConfig({ projectRoot: opts.projectRoot, env: opts.env });
    // A scalar value's provenance is a single source; a merged (deny-list) value has many. These
    // config keys are all scalar, so read the single winning source's scope.
    const scopeOf = (
      key: 'model' | 'baseUrl' | 'apiKeyEnv' | 'permissionProfile' | 'telemetry',
    ): string => {
      const p = provenanceOf(resolved, key);
      return p && p.kind === 'value' ? p.source.scope : 'builtin';
    };
    lines.push('config:');
    lines.push(`  model = ${resolved.model.value}  (from ${scopeOf('model')})`);
    lines.push(`  baseUrl = ${resolved.baseUrl.value}  (from ${scopeOf('baseUrl')})`);
    lines.push(`  apiKeyEnv = ${resolved.apiKeyEnv.value}  (from ${scopeOf('apiKeyEnv')})`);
    lines.push(
      `  permissionProfile = ${resolved.permissionProfile.value}  (from ${scopeOf('permissionProfile')})`,
    );

    // --- telemetry (OB-02): opt-in, and it says so either way ---
    const traceFiles = listTraceFiles(join(opts.projectRoot, '.qwen-harness', 'trace'));
    lines.push(
      `telemetry: ${resolved.telemetry.value ? '✓ enabled' : '· disabled (opt-in)'} ` +
        `(from ${scopeOf('telemetry')}), level=${resolved.telemetryLevel.value}, ` +
        `retention=${resolved.telemetryRetentionDays.value}d, trace files=${traceFiles.length}`,
    );

    // Credential PRESENCE only — never the value.
    const keyEnvName = resolved.apiKeyEnv.value;
    const present = Boolean(opts.env[keyEnvName]);
    lines.push(
      `credential: ${keyEnvName} is ${present ? '✓ present' : '✗ absent'} (value never read or printed here)`,
    );
    if (!present) {
      lines.push('  the live model gate cannot run without it; deterministic work is unaffected');
    }
  } catch (e) {
    lines.push(`config: ✗ ${e instanceof Error ? e.message : String(e)}`);
    healthy = false;
  }

  // --- storage + migrations (OB-03) ---
  // Reported WITHOUT opening the database. `doctor` must be safe to run against a workspace another
  // process is using, and it must never be the thing that applies a migration as a side effect of
  // being asked a question.
  lines.push(`storage: this build supports schema version ${LATEST_SCHEMA_VERSION}`);
  lines.push(`  state: ${join(opts.projectRoot, '.qwen-harness', 'sessions.sqlite')}`);
  lines.push(
    '  migrations apply when a session is opened; a database written by a NEWER build is refused',
  );

  // --- repository instructions (IN-06) ---
  try {
    const guidance = loadGuidance({ workspaceRoot: opts.projectRoot, homeDir });
    lines.push(`instructions: ${guidance.sources.length} AGENTS.md file(s) in effect`);
    for (const source of guidance.sources) lines.push(`  · [${source.scope}] ${source.path}`);
  } catch (e) {
    lines.push(`instructions: ✗ ${e instanceof Error ? e.message : String(e)}`);
    degraded.push('repository instructions could not be read');
  }

  // --- hooks (HK-01) ---
  try {
    const hooks = loadHooks({ workspaceRoot: opts.projectRoot, homeDir });
    lines.push(`hooks: ${hooks.registrations.length} registered`);
    for (const source of hooks.sources) {
      lines.push(`  · [${source.scope}] ${source.path} (${source.count})`);
    }
  } catch (e) {
    // A hook file that will not parse is a serious degradation: the user believes a security hook
    // is running, and it is not. This is not a warning to be tucked away.
    lines.push(`hooks: ✗ ${e instanceof Error ? e.message : String(e)}`);
    degraded.push('a hook file is invalid; its hooks are NOT running');
    healthy = false;
  }

  // --- skills (IN-01..IN-03) ---
  try {
    const skills = createSkillSurface({
      workspaceRoot: opts.projectRoot,
      homeDir,
      clock: { now: () => Date.now(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
    });
    lines.push(`skills: ${skills.skills.length} discovered`);
    for (const skill of skills.skills) lines.push(`  · ${skill.name} [${skill.source}]`);
    for (const error of skills.errors) {
      lines.push(`  ✗ ${error.name}: ${error.message}`);
      degraded.push(`skill '${error.name}' failed validation and is not available`);
    }
  } catch (e) {
    lines.push(`skills: ✗ ${e instanceof Error ? e.message : String(e)}`);
    degraded.push('skill discovery failed');
  }

  // --- MCP (MC-05/MC-06) ---
  try {
    const mcp = loadMcpConfiguration({ workspaceRoot: opts.projectRoot, homeDir });
    lines.push(`mcp: ${mcp.resolved.length} server(s) configured`);
    for (const server of mcp.resolved) {
      const status = server.active ? '✓ active' : `· inactive — ${server.inactiveReason}`;
      lines.push(`  ${status}  ${server.config.name} [${server.source}]`);
      if (!server.active && !server.trusted) {
        degraded.push(
          `MCP server '${server.config.name}' is configured but NOT trusted; ` +
            `enable it with \`qwen-harness mcp trust ${server.config.name}\``,
        );
      }
    }
    lines.push('  note: only `stdio` servers can be launched from a config file in this build');
  } catch (e) {
    lines.push(`mcp: ✗ ${e instanceof Error ? e.message : String(e)}`);
    degraded.push('MCP configuration is invalid; no server will be connected');
    healthy = false;
  }

  // --- known degradation (OB-03) ---
  if (degraded.length > 0) {
    lines.push('');
    lines.push('known degradation:');
    for (const item of degraded) lines.push(`  ! ${item}`);
  }

  return { lines, healthy };
}
