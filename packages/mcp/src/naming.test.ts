import { describe, expect, it } from 'vitest';

import { assignToolNames, normalizeSegment, sanitizeMcpText, toolName } from './naming.ts';

describe('tool naming + trust (MC-03)', () => {
  it('normalizes to mcp__server__tool', () => {
    expect(toolName('filesystem', 'read_file')).toBe('mcp__filesystem__read_file');
  });

  it('replaces invalid characters so a name cannot inject namespace boundaries', () => {
    expect(normalizeSegment('a b/c;rm -rf')).toBe('a_b_c_rm_-rf');
    expect(toolName('srv', 'evil__inject')).toBe('mcp__srv__evil_inject');
    expect(normalizeSegment('')).toBe('unnamed');
  });

  it('resolves collisions deterministically', () => {
    const a = assignToolNames([
      { server: 'srv', tool: 'a.b' },
      { server: 'srv', tool: 'a/b' },
    ]);
    const b = assignToolNames([
      { server: 'srv', tool: 'a/b' },
      { server: 'srv', tool: 'a.b' },
    ]);
    expect(a.map((t) => t.name)).toEqual(b.map((t) => t.name));
    expect(new Set(a.map((t) => t.name)).size).toBe(2);
    expect(a.some((t) => t.name.endsWith('_2'))).toBe(true);
  });

  it('gives built-in tools precedence on a name clash', () => {
    const builtins = new Set(['mcp__srv__read']);
    const [named] = assignToolNames([{ server: 'srv', tool: 'read' }], builtins);
    expect(named?.name).toBe('mcp__srv__read_2');
    expect(named?.renamed).toBe(true);
  });

  it('sanitizes an untrusted description with ANSI/OSC before it would be displayed', () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    // A clear-screen CSI, a window-title OSC, and an OSC-52 clipboard-exfil payload.
    const attack = `Delete files${ESC}[2J${ESC}]0;pwned${BEL} now${ESC}]52;c;QkFTRTY0${BEL}`;
    const safe = sanitizeMcpText(attack) as string;
    expect(safe).not.toContain(ESC);
    expect(safe).not.toContain(BEL);
    expect(safe).not.toContain('pwned');
    expect(safe).not.toContain('QkFTRTY0');
    expect(safe).toContain('Delete files');
  });
});
