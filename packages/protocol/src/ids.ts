import { z } from 'zod';

/**
 * Branded identifiers. Branding is not decoration: it makes it a *type error* to pass a TurnId
 * where a ThreadId belongs, which is the class of bug that corrupts an event log silently.
 */
// Exported because declaration emit must be able to name the symbol used in the brand.
export declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ThreadId = Brand<string, 'ThreadId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type ItemId = Brand<string, 'ItemId'>;
export type EventId = Brand<string, 'EventId'>;
export type ToolCallId = Brand<string, 'ToolCallId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;
export type CausationId = Brand<string, 'CausationId'>;
export type ActorId = Brand<string, 'ActorId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type TeamId = Brand<string, 'TeamId'>;
export type SideEffectId = Brand<string, 'SideEffectId'>;

const idPattern = /^[a-z]{2,4}_[0-9a-zA-Z_-]{6,64}$/;

/**
 * Every ID is `<prefix>_<opaque>`; the prefix makes a mis-routed ID visible in a log.
 * The brand is supplied as an explicit type argument rather than a phantom runtime parameter.
 */
function idSchema<B extends string>(prefix: string) {
  return z
    .string()
    .regex(idPattern, `expected an id like "${prefix}_..."`)
    .refine((v) => v.startsWith(`${prefix}_`), {
      message: `expected prefix "${prefix}_"`,
    }) as unknown as z.ZodType<Brand<string, B>>;
}

export const ThreadIdSchema = idSchema<'ThreadId'>('thr');
export const TurnIdSchema = idSchema<'TurnId'>('trn');
export const ItemIdSchema = idSchema<'ItemId'>('itm');
export const EventIdSchema = idSchema<'EventId'>('evt');
export const ToolCallIdSchema = idSchema<'ToolCallId'>('call');
export const CorrelationIdSchema = idSchema<'CorrelationId'>('cor');
export const CausationIdSchema = idSchema<'CausationId'>('cau');
export const ActorIdSchema = idSchema<'ActorId'>('act');
export const TaskIdSchema = idSchema<'TaskId'>('tsk');
export const AgentIdSchema = idSchema<'AgentId'>('agt');
export const TeamIdSchema = idSchema<'TeamId'>('tem');
export const SideEffectIdSchema = idSchema<'SideEffectId'>('sfx');

export const ID_PREFIXES = {
  thread: 'thr',
  turn: 'trn',
  item: 'itm',
  event: 'evt',
  toolCall: 'call',
  correlation: 'cor',
  causation: 'cau',
  actor: 'act',
  task: 'tsk',
  agent: 'agt',
  team: 'tem',
  sideEffect: 'sfx',
} as const;

/**
 * ID generation is an *interface*, never an ambient call. `protocol` performs no randomness,
 * which is what lets the whole runtime be replayed deterministically (RT-08).
 */
export interface IdSource {
  next(prefix: string): string;
}
