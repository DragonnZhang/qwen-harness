/**
 * What the registry stores about a skill BEFORE its body is ever read (IN-01).
 *
 * A descriptor is level one of the two-level load: validated metadata, a source, and an origin. The
 * body is NOT here. It cannot be here — if it were, "discover the catalog" would mean "read every
 * skill body on disk", which is the exact cost two-level loading exists to avoid, and the exact
 * blast radius (every SKILL.md in every scanned directory, in context, unread by anyone) the threat
 * model cares about.
 */

import type { SkillFrontmatter } from './frontmatter.ts';
import type { SkillSource } from './sources.ts';

/**
 * Where a skill's content lives.
 *
 * `file`: on disk, under a CANONICAL root (already realpath'd and validated). The body is read
 *   lazily, exactly once, on invocation.
 * `memory`: supplied in-process — a dynamic (session/SDK-registered) skill or one advertised by an
 *   MCP server over the wire. It has NO filesystem root, so it can reference no files at all: every
 *   resource resolution for such a skill is rejected with `no-root`. That is not a limitation to
 *   work around; it is the point. A remote server must not be able to name a local path.
 */
export type SkillOrigin =
  | { readonly kind: 'file'; readonly root: string; readonly file: string }
  | { readonly kind: 'memory'; readonly body: string };

export interface SkillDescriptor {
  /** The registry key. Always equals `frontmatter.name`. Path-safe by schema. */
  readonly name: string;
  readonly source: SkillSource;
  readonly frontmatter: SkillFrontmatter;
  readonly origin: SkillOrigin;
  /** The plugin/MCP server/provider that supplied this skill, for provenance. `null` otherwise. */
  readonly provider: string | null;
}

/** Provenance a user (or `doctor`) can read to answer "why is this skill here, and from where?". */
export interface SkillProvenance {
  readonly name: string;
  readonly source: SkillSource;
  readonly provider: string | null;
  /** Absolute path of the SKILL.md, or `null` for an in-memory skill. */
  readonly file: string | null;
  readonly root: string | null;
}

export function provenanceOf(descriptor: SkillDescriptor): SkillProvenance {
  const origin = descriptor.origin;
  return {
    name: descriptor.name,
    source: descriptor.source,
    provider: descriptor.provider,
    file: origin.kind === 'file' ? origin.file : null,
    root: origin.kind === 'file' ? origin.root : null,
  };
}
