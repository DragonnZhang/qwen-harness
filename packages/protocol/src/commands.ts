import { z } from 'zod';

import { PermissionProfileSchema } from './domain.ts';
import { ThreadIdSchema, ToolCallIdSchema, TurnIdSchema } from './ids.ts';

/**
 * The command protocol. Clients (TUI, CLI, daemon socket peers) send these; the runtime emits
 * events. A client never mutates runtime state directly, which is what makes TUI and CLI
 * genuinely interchangeable and lets tests drive the runtime without a terminal (UI-15).
 */

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start-turn'),
    threadId: ThreadIdSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal('approve'),
    threadId: ThreadIdSchema,
    callId: ToolCallIdSchema.nullable(),
    granted: z.boolean(),
    scope: z.enum(['once', 'session', 'rule']).nullable(),
  }),
  z.object({
    type: z.literal('interrupt'),
    threadId: ThreadIdSchema,
  }),
  /** Steering: input DURING a turn that must not corrupt tool/result pairing (RT-07). */
  z.object({
    type: z.literal('steer'),
    threadId: ThreadIdSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal('compact'),
    threadId: ThreadIdSchema,
    focus: z.string().nullable(),
  }),
  z.object({
    type: z.literal('clear'),
    threadId: ThreadIdSchema,
  }),
  z.object({
    type: z.literal('set-permission-profile'),
    threadId: ThreadIdSchema,
    profile: PermissionProfileSchema,
  }),
  z.object({
    type: z.literal('create-thread'),
    cwd: z.string(),
    name: z.string().nullable(),
  }),
  z.object({
    type: z.literal('resume-thread'),
    threadId: ThreadIdSchema,
  }),
  z.object({
    type: z.literal('fork-thread'),
    threadId: ThreadIdSchema,
    atSeq: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    type: z.literal('rewind'),
    threadId: ThreadIdSchema,
    toTurnId: TurnIdSchema,
    restore: z.enum(['conversation', 'code', 'both']),
  }),
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command['type'];

/** Versioned so a daemon and a client of different builds fail loudly, not subtly (SS-08). */
export const PROTOCOL_VERSION = 1;

export const ClientHelloSchema = z.object({
  protocolVersion: z.number().int().positive(),
  clientName: z.string().max(100),
});
export type ClientHello = z.infer<typeof ClientHelloSchema>;
