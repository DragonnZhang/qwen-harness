import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DEFAULT_HEARTBEAT, TeamRecovery, type IncarnationState } from './index.ts';

describe('TeamRecovery incarnation/heartbeat (AG-13)', () => {
  it('latest incarnation wins and an old incarnation heartbeat is rejected', () => {
    const r = new TeamRecovery();
    r.spawn('mem_alfa', 'inc_1', 1_000);
    expect(r.heartbeat('mem_alfa', 'inc_1', 1_100)).toBe(true);

    // Resume: a new incarnation under the same logical id. The old one is lost, not running.
    r.spawn('mem_alfa', 'inc_2', 1_200);
    expect(r.state('mem_alfa')).toBe('running');
    // The old incarnation can never heartbeat again — the latest one owns the identity.
    expect(r.heartbeat('mem_alfa', 'inc_1', 1_300)).toBe(false);
    expect(r.heartbeat('mem_alfa', 'inc_2', 1_300)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AG-13 property: over randomized orderings of spawn / heartbeat / detectLost
// events, an old incarnation's heartbeat (and a stale request) is ALWAYS
// rejected, the latest incarnation always wins, and an incarnation idle past
// the heartbeat timeout is exactly the set that becomes lost.
// ---------------------------------------------------------------------------

const MEMBERS = ['mem_alfa', 'mem_bravo', 'mem_charlie'] as const;
const TIMEOUT = DEFAULT_HEARTBEAT.heartbeatTimeoutMs;

interface ModelRec {
  inc: string;
  state: IncarnationState;
  lastHb: number;
}

type Command =
  | { readonly t: 'spawn'; readonly member: string; readonly dt: number }
  | {
      readonly t: 'heartbeat';
      readonly member: string;
      readonly target: 'current' | 'stale' | 'bogus';
      readonly dt: number;
    }
  | { readonly t: 'detectLost'; readonly dt: number };

describe('TeamRecovery incarnation FSM (AG-13, property)', () => {
  it('rejects stale incarnations, keeps the latest, and loses exactly the expired ones', () => {
    const dt = fc.nat({ max: 60_000 });
    const memberGen = fc.constantFrom(...MEMBERS);
    const command = fc.oneof(
      fc.record({ t: fc.constant('spawn' as const), member: memberGen, dt }),
      fc.record({
        t: fc.constant('heartbeat' as const),
        member: memberGen,
        target: fc.constantFrom('current' as const, 'stale' as const, 'bogus' as const),
        dt,
      }),
      fc.record({ t: fc.constant('detectLost' as const), dt }),
    );

    fc.assert(
      fc.property(
        fc.array(command as fc.Arbitrary<Command>, { minLength: 1, maxLength: 60 }),
        (commands) => {
          const r = new TeamRecovery();
          const model = new Map<string, ModelRec>();
          const history = new Map<string, string[]>();
          let now = 1_000;
          let incCounter = 0;
          let bogusCounter = 0;

          for (const cmd of commands) {
            now += cmd.dt;

            if (cmd.t === 'spawn') {
              const incId = `inc_${incCounter++}`;
              const prior = model.get(cmd.member);
              if (prior !== undefined && prior.state === 'running') prior.state = 'lost';
              model.set(cmd.member, { inc: incId, state: 'running', lastHb: now });
              const seen = history.get(cmd.member) ?? [];
              seen.push(incId);
              history.set(cmd.member, seen);

              r.spawn(cmd.member, incId, now);
              expect(r.state(cmd.member)).toBe('running');
            } else if (cmd.t === 'heartbeat') {
              const rec = model.get(cmd.member);
              let incId: string;
              if (cmd.target === 'current') {
                incId = rec?.inc ?? 'inc_absent';
              } else if (cmd.target === 'stale') {
                const seen = history.get(cmd.member) ?? [];
                const staleId = seen.find((id) => id !== rec?.inc);
                incId = staleId ?? `inc_bogus_${bogusCounter++}`;
              } else {
                incId = `inc_bogus_${bogusCounter++}`;
              }

              const expected = rec !== undefined && rec.inc === incId && rec.state === 'running';
              expect(r.heartbeat(cmd.member, incId, now)).toBe(expected);
              if (expected && rec !== undefined) rec.lastHb = now;

              // A heartbeat that is NOT the current running incarnation is always rejected.
              if (incId !== rec?.inc || rec?.state !== 'running') {
                expect(r.heartbeat(cmd.member, incId, now)).toBe(false);
              }
            } else {
              const modelLost: string[] = [];
              for (const [m, rec] of model) {
                if (rec.state === 'running' && now - rec.lastHb > TIMEOUT) {
                  rec.state = 'lost';
                  modelLost.push(m);
                }
              }
              const got = r.detectLost(now);
              expect([...got].sort()).toEqual(modelLost.sort());
            }

            // After every command, tracker state agrees with the reference model.
            for (const m of MEMBERS) {
              expect(r.state(m)).toBe(model.get(m)?.state ?? 'unknown');
            }
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
