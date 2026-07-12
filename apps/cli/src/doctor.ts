import { detectCapability } from '@qwen-harness/sandbox-linux';
import { loadResolvedConfig, provenanceOf } from '@qwen-harness/config';

/**
 * `doctor` — the environment report (OB-03/SB-03). It explains what the harness can and cannot do
 * on this host, and WHY, without ever printing a secret value. Credential presence is reported as
 * a boolean; the value is never read here.
 */
export interface DoctorReport {
  readonly lines: string[];
  /** True only when nothing blocks a safe, non-degraded run. */
  readonly healthy: boolean;
}

export function runDoctor(opts: {
  projectRoot: string;
  env: Record<string, string | undefined>;
}): DoctorReport {
  const lines: string[] = [];
  let healthy = true;

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
    const scopeOf = (key: 'model' | 'baseUrl' | 'apiKeyEnv' | 'permissionProfile'): string => {
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

  return { lines, healthy };
}
