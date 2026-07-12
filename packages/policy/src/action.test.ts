import { describe, expect, it } from 'vitest';

import {
  ACTION_KINDS,
  actionDigest,
  canonicalJson,
  checkCanonicalAction,
  describeAction,
  isSideEffect,
} from './action.ts';
import { WORKSPACE, fileRead, fileWrite, gitRead, mcp, network, shell } from '../test/helpers.ts';

describe('actionDigest', () => {
  it('is stable across key order', () => {
    const a = { kind: 'file-read', path: '/x' } as const;
    const b = { path: '/x', kind: 'file-read' } as const;
    expect(actionDigest(a)).toBe(actionDigest(b));
  });

  it('is a sha256 hex digest', () => {
    expect(actionDigest(fileRead('/x'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any parameter changes', () => {
    const base = fileWrite(`${WORKSPACE}/a.txt`, 'one');
    const digests = new Set([
      actionDigest(base),
      actionDigest(fileWrite(`${WORKSPACE}/a.txt`, 'two')),
      actionDigest(fileWrite(`${WORKSPACE}/b.txt`, 'one')),
      actionDigest(fileWrite(`${WORKSPACE}/a.txt`, 'one', true)),
    ]);
    expect(digests.size).toBe(4);
  });

  it('canonicalJson sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe('side-effect classification', () => {
  it('reads are not side effects', () => {
    expect(isSideEffect(fileRead('/x'))).toBe(false);
    expect(isSideEffect(gitRead())).toBe(false);
    expect(isSideEffect(mcp(false))).toBe(false);
  });

  it('mutations, network, and side-effecting MCP calls are', () => {
    expect(isSideEffect(fileWrite('/x'))).toBe(true);
    expect(isSideEffect(shell('ls'))).toBe(true);
    expect(isSideEffect(network())).toBe(true);
    expect(isSideEffect(mcp(true))).toBe(true);
  });

  it('every declared kind is reachable', () => {
    expect(ACTION_KINDS).toHaveLength(9);
  });
});

describe('checkCanonicalAction', () => {
  it('accepts a canonical action', () => {
    expect(checkCanonicalAction(fileWrite(`${WORKSPACE}/a.txt`))).toEqual([]);
  });

  it('rejects a bad content digest', () => {
    const bad = { ...fileWrite('/x'), contentDigest: 'nope' } as const;
    expect(checkCanonicalAction(bad)[0]?.why).toContain('sha256');
  });

  it('rejects an uppercase network host (two spellings of one host)', () => {
    const bad = { ...network('https://Example.com/', 'Example.com') };
    expect(checkCanonicalAction(bad)[0]?.why).toContain('lowercased');
  });

  it('rejects a shell action with no argv', () => {
    const bad = { ...shell('ls'), argv: [] };
    expect(checkCanonicalAction(bad)[0]?.why).toContain('argv');
  });
});

describe('describeAction', () => {
  it('renders the exact parameters a human must approve', () => {
    expect(describeAction(fileWrite('/x/y.txt'))).toBe('write /x/y.txt');
    expect(describeAction(shell('npm test', '/x'))).toBe('run `npm test` in /x');
    expect(describeAction(network('https://a.test/p', 'a.test'))).toBe('GET https://a.test/p');
  });
});
