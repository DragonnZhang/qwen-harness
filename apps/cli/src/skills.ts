import { join } from 'node:path';

import { defaultAuthority, type ManagedPolicy } from '@qwen-harness/policy';
import type { Clock, PermissionProfile } from '@qwen-harness/protocol';
import {
  SkillRegistry,
  defaultSkillSourceDirs,
  discoverSkills,
  nodeSkillFileSystem,
  renderCatalogEntry,
  type PreparedInvocation,
  type SkillCatalog,
  type SkillDescriptor,
} from '@qwen-harness/skills';

/**
 * Skills, made reachable (IN-01..IN-05).
 *
 * `@qwen-harness/skills` implemented two-level loading, the source precedence table, strict
 * frontmatter validation, symlink-escape defence, and the rule that a skill's `allowed-tools` can
 * only NARROW the caller's authority — and no application imported it, so no user could list a
 * skill, let alone run one.
 *
 * TWO-LEVEL LOADING (IN-01) is the shape of everything below. Discovery reads only the frontmatter
 * of each `SKILL.md` — enough to build a catalog and no more. The body is loaded ONLY when a skill
 * is actually invoked. A repository with fifty skills therefore costs fifty frontmatter reads, not
 * fifty full documents in the context window.
 *
 * A SKILL IS UNTRUSTED CONTENT ADDRESSED BY NAME (IN-02). The registry is the only way to reach one,
 * and `invoke` takes a NAME. There is deliberately no path in this file that a model could point at
 * a file with — not because a check would be hard, but because the check would then be the only
 * thing standing between `../../etc/shadow` and a read.
 *
 * AUTHORITY (IN-05). `invoke` is handed the run's real authority and the managed ceiling. The
 * package intersects them: a skill declaring `allowed-tools: [run_shell]` inside a `plan`-profile
 * run does not get a shell. A skill cannot widen anything, and `assertPlanNeverBroadens` in the
 * package is what proves it — this file just refuses to hand it a bigger ceiling than the run has.
 */

export interface SkillSurfaceOptions {
  readonly workspaceRoot: string;
  readonly homeDir: string;
  readonly clock: Clock;
}

export interface SkillSurface {
  readonly registry: SkillRegistry;
  readonly skills: readonly SkillDescriptor[];
  /** Skills whose frontmatter or scope was rejected. Surfaced by `doctor`, never silently dropped. */
  readonly errors: readonly { name: string; message: string }[];
  catalog(): SkillCatalog;
  /** Prepare an invocation. Throws `SkillNotFoundError` for an unknown name. */
  invoke(input: {
    name: string;
    args: readonly string[];
    invoker: 'user' | 'model';
    profile: PermissionProfile;
    managed: ManagedPolicy;
    toolNames: readonly string[];
  }): PreparedInvocation;
}

/**
 * Discover every skill visible from this workspace.
 *
 * The source dirs come from the package's own precedence table (managed > user > project > …), so
 * the CLI does not get to invent an ordering — a managed skill outranks a project one because
 * `resolvePrecedence` says so, and `MANAGED_IS_IMMUTABLE` means a repository cannot shadow it.
 */
export function createSkillSurface(opts: SkillSurfaceOptions): SkillSurface {
  const fs = nodeSkillFileSystem();

  const sources = defaultSkillSourceDirs({
    managedDir: '/etc/qwen-harness',
    userConfigDir: join(opts.homeDir, '.config', 'qwen-harness'),
    repoRoot: opts.workspaceRoot,
  });

  const discovery = discoverSkills({ fs, sources });

  const registry = new SkillRegistry({ fs, clock: opts.clock });
  const registration = registry.registerAll(discovery.skills);

  const errors = [
    ...discovery.errors.map((e) => ({ name: e.name, message: e.message })),
    ...registration.rejected.map((r) => ({ name: r.name, message: r.error.message })),
  ];

  return {
    registry,
    skills: registration.registered,
    errors,
    catalog: () => registry.catalog({ workspaceRoot: opts.workspaceRoot }),
    invoke: (input) =>
      registry.invoke({
        name: input.name,
        args: input.args,
        invoker: input.invoker,
        parentTools: [...input.toolNames],
        // The authority the RUN has — never more. `defaultAuthority` derives it from the effective
        // profile and the managed ceiling, so a skill inherits exactly what the turn already had.
        parentAuthority: defaultAuthority(input.profile, opts.workspaceRoot, input.managed),
        managed: input.managed,
      }),
  };
}

/** Render the catalog for a human (`skills` command). */
export function renderCatalog(catalog: SkillCatalog): string[] {
  const lines: string[] = [];
  for (const entry of catalog.entries) lines.push(renderCatalogEntry(entry));
  for (const omission of catalog.omitted) {
    lines.push(`  (omitted: ${omission.name} — ${omission.reason})`);
  }
  return lines;
}
