/**
 * Exact-parameter binding: the property that an approval for action A never authorizes action B.
 *
 * The property test is the real evidence. Any two DIFFERENT actions drawn from the generator must
 * not share a grant — including the pairs a human reviewer would never think to write down, like
 * "same path, one byte of different content" or "same command, different cwd".
 */

import { describe, expect, it } from 'vitest';

import { actionDigest, type NormalizedAction } from './action.ts';
import { PolicyEngine } from './engine.ts';
import { consumeGrant, findGrant, isGrantLive, revokeGrant, validateRuleGrant } from './grants.ts';
import {
  HOME,
  NOW,
  Rng,
  WORKSPACE,
  ctx,
  fileEdit,
  fileWrite,
  grant,
  mcp,
  network,
  patch,
  shell,
} from '../test/helpers.ts';

const engine = new PolicyEngine();
const lookup = { workspaceRoot: WORKSPACE, homeDir: HOME };

describe('a grant binds to the exact action and nothing else', () => {
  it('a grant for one file does not authorize another file', () => {
    const approved = fileWrite(`${WORKSPACE}/a.txt`, 'hello');
    const other = fileWrite(`${WORKSPACE}/b.txt`, 'hello');
    const g = grant({ id: 'g1', scope: 'session', actionDigest: actionDigest(approved) });

    expect(engine.evaluate(approved, ctx({ profile: 'ask', grants: [g] })).outcome).toBe('allow');
    expect(engine.evaluate(other, ctx({ profile: 'ask', grants: [g] })).outcome).toBe('ask');
  });

  it('a grant for one CONTENT does not authorize different content at the same path', () => {
    const approved = fileWrite(`${WORKSPACE}/a.txt`, 'safe content');
    const swapped = fileWrite(`${WORKSPACE}/a.txt`, 'rm -rf / # different content');
    const g = grant({ id: 'g1', scope: 'session', actionDigest: actionDigest(approved) });

    expect(engine.evaluate(approved, ctx({ profile: 'ask', grants: [g] })).outcome).toBe('allow');
    expect(engine.evaluate(swapped, ctx({ profile: 'ask', grants: [g] })).outcome).toBe('ask');
  });

  it('a grant for a shell command does not authorize the same command in another cwd', () => {
    const approved = shell('npm test', WORKSPACE);
    const elsewhere = shell('npm test', `${WORKSPACE}/vendor`);
    const g = grant({ id: 'g1', scope: 'session', actionDigest: actionDigest(approved) });

    expect(engine.evaluate(approved, ctx({ profile: 'ask', grants: [g] })).outcome).toBe('allow');
    expect(engine.evaluate(elsewhere, ctx({ profile: 'ask', grants: [g] })).outcome).toBe('ask');
  });

  it('a grant for a write does not authorize an edit of the same path', () => {
    const approved = fileWrite(`${WORKSPACE}/a.txt`, 'x');
    const edit = fileEdit(`${WORKSPACE}/a.txt`, 'x');
    const g = grant({ id: 'g1', scope: 'session', actionDigest: actionDigest(approved) });
    expect(engine.evaluate(edit, ctx({ profile: 'ask', grants: [g] })).outcome).toBe('ask');
  });

  it('PROPERTY: no grant for action A ever authorizes a different action B', () => {
    const rng = new Rng(0xc0ffee);
    const paths = [
      `${WORKSPACE}/a.txt`,
      `${WORKSPACE}/b.txt`,
      `${WORKSPACE}/src/deep/c.ts`,
      `${WORKSPACE}/.env`,
      '/home/dev/other/x.txt',
    ];
    const contents = ['one', 'two', 'three'];
    const commands = ['npm test', 'npm run build', 'rm -rf build'];
    const hosts = ['example.com', 'evil.test'];

    const generate = (): NormalizedAction => {
      switch (rng.int(6)) {
        case 0:
          return fileWrite(rng.pick(paths), rng.pick(contents), rng.bool());
        case 1:
          return fileEdit(rng.pick(paths), rng.pick(contents));
        case 2:
          return patch([rng.pick(paths), rng.pick(paths)], rng.pick(contents));
        case 3:
          return shell(rng.pick(commands), rng.pick([WORKSPACE, `${WORKSPACE}/sub`]));
        case 4:
          return network(`https://${rng.pick(hosts)}/p`, rng.pick(hosts));
        default:
          return mcp(rng.bool(), rng.pick(['create_issue', 'delete_repo']));
      }
    };

    let checked = 0;
    for (let i = 0; i < 3000; i += 1) {
      const a = generate();
      const b = generate();
      const da = actionDigest(a);
      const db = actionDigest(b);

      // Same digest <=> same action. That equivalence is the whole contract.
      expect(da === db).toBe(JSON.stringify(a) === JSON.stringify(b));
      if (da === db) continue;

      const g = grant({ id: 'g', scope: 'session', actionDigest: da });
      const found = findGrant([g], b, db, { exactOnly: false, now: NOW, homeDir: HOME });
      expect(found.grant).toBeNull();
      checked += 1;
    }
    expect(checked).toBeGreaterThan(2000);
  });
});

describe('grant lifetime', () => {
  const action = fileWrite(`${WORKSPACE}/a.txt`);
  const digest = actionDigest(action);

  it('a `once` grant is spent after one use', () => {
    let grants = [grant({ id: 'g1', scope: 'once' as const, actionDigest: digest })];
    expect(engine.evaluate(action, ctx({ profile: 'ask', grants })).outcome).toBe('allow');

    grants = [...consumeGrant(grants, 'g1', NOW)];
    const decision = engine.evaluate(action, ctx({ profile: 'ask', grants }));
    expect(decision.outcome).toBe('ask');
    expect(decision.trace.some((s) => s.note.includes('already-used'))).toBe(true);
  });

  it('an expired grant does not authorize anything', () => {
    const grants = [
      grant({ id: 'g1', scope: 'session', actionDigest: digest, expiresAt: NOW + 1000 }),
    ];
    expect(engine.evaluate(action, ctx({ profile: 'ask', grants, now: NOW })).outcome).toBe(
      'allow',
    );
    expect(engine.evaluate(action, ctx({ profile: 'ask', grants, now: NOW + 1000 })).outcome).toBe(
      'ask',
    );
    expect(isGrantLive(grants[0]!, NOW + 5000)).toBe('expired');
  });

  it('a revoked grant does not authorize anything', () => {
    const grants = revokeGrant(
      [grant({ id: 'g1', scope: 'session', actionDigest: digest })],
      'g1',
      NOW,
    );
    const decision = engine.evaluate(
      action,
      ctx({ profile: 'ask', grants: [...grants], now: NOW + 1 }),
    );
    expect(decision.outcome).toBe('ask');
    expect(decision.trace.some((s) => s.note.includes('revoked'))).toBe(true);
  });
});

describe('narrow rule grants', () => {
  const ruleGrant = grant({
    id: 'rg',
    scope: 'rule' as const,
    match: { kinds: ['shell'], paths: [`${WORKSPACE}/**`], commandLines: ['npm test*'] },
  });

  it('a validated rule grant authorizes every action it matches', () => {
    expect(validateRuleGrant(ruleGrant, lookup).ok).toBe(true);
    expect(
      engine.evaluate(shell('npm test --watch'), ctx({ profile: 'ask', grants: [ruleGrant] }))
        .outcome,
    ).toBe('allow');
    expect(
      engine.evaluate(shell('npm publish'), ctx({ profile: 'ask', grants: [ruleGrant] })).outcome,
    ).toBe('ask');
  });

  it('a rule grant can NEVER reach a protected path, however it is written', () => {
    const overbroad = grant({
      id: 'rg2',
      scope: 'rule' as const,
      match: { kinds: ['file-write'], paths: [`${WORKSPACE}/**`] },
    });
    // It validates (the anchor is inside the workspace) ...
    expect(validateRuleGrant(overbroad, lookup).ok).toBe(true);
    // ... and it still cannot authorize the .env write, because a protected action only accepts a
    // digest-bound grant.
    const decision = engine.evaluate(
      fileWrite(`${WORKSPACE}/.env`),
      ctx({ profile: 'ask', grants: [overbroad] }),
    );
    expect(decision.outcome).toBe('ask');
    expect(decision.trace.some((s) => s.note.includes('scope-not-allowed-here'))).toBe(true);
  });

  it('rejects a rule grant anchored outside the workspace', () => {
    const escape = grant({
      id: 'rg3',
      scope: 'rule' as const,
      match: { kinds: ['file-write'], paths: ['/etc/**'] },
    });
    expect(validateRuleGrant(escape, lookup).problems).toContain('path-outside-workspace');
  });

  it('rejects a rule grant anchored at a protected path', () => {
    const escape = grant({
      id: 'rg4',
      scope: 'rule' as const,
      match: { kinds: ['file-write'], paths: [`${WORKSPACE}/.git/**`] },
    });
    expect(validateRuleGrant(escape, lookup).problems).toContain('path-is-protected');
  });

  it('rejects a rule grant with no kinds and an unanchored glob', () => {
    const vague = grant({ id: 'rg5', scope: 'rule' as const, match: { paths: ['**'] } });
    const result = validateRuleGrant(vague, lookup);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('missing-kinds');
    expect(result.problems).toContain('unbounded-path-glob');
  });

  it('an empty matcher matches nothing (fail closed)', () => {
    const empty = grant({ id: 'rg6', scope: 'rule' as const, match: {} });
    expect(validateRuleGrant(empty, lookup).problems).toContain('empty-matcher');
    expect(
      engine.evaluate(shell('anything'), ctx({ profile: 'ask', grants: [empty] })).outcome,
    ).toBe('ask');
  });
});
