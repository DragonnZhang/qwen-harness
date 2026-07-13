import {
  canTransition,
  isTerminalTurnState,
  type TerminationReason,
  type TurnState,
} from '@qwen-harness/protocol';

/**
 * The turn state machine (RT-03), as an explicit object rather than an implicit tangle of booleans.
 *
 * Every transition is checked against the legal-transition table in `protocol`. An illegal
 * transition throws rather than silently corrupting the turn — a turn that reaches an impossible
 * state is a bug we want to see immediately, in a test, not a mystery in production.
 *
 * The machine owns NO I/O. It records intent ("we are now streaming") and the caller is
 * responsible for persisting that transition before acting on it — which is what "persist a
 * transition before presenting it as complete" means in practice.
 */
export class TurnMachine {
  #state: TurnState;
  #reason: TerminationReason | null = null;
  readonly #history: TurnState[];

  /**
   * A fresh turn starts `preparing`. A turn RESTORED from the durable log starts at the state the
   * log says it reached — that is what lets a new process pick up a turn that was left
   * `awaiting-approval` and resume it as the SAME turn, rather than inventing a new one. The log is
   * the truth; the machine is reconstructed from it, not the other way round.
   */
  constructor(restoredState: TurnState = 'preparing') {
    this.#state = restoredState;
    this.#history = [restoredState];
  }

  get state(): TurnState {
    return this.#state;
  }

  get terminationReason(): TerminationReason | null {
    return this.#reason;
  }

  get isTerminal(): boolean {
    return isTerminalTurnState(this.#state);
  }

  /** The full path this turn took. Used by tests and by the trace to explain what happened. */
  get history(): readonly TurnState[] {
    return this.#history;
  }

  /**
   * Attempt a transition. Returns the new state or throws on an illegal one.
   *
   * A terminal state accepts no further transitions — once a turn is `completed` or `failed`, it
   * stays there. That is what makes a terminal outcome trustworthy.
   */
  transition(to: TurnState): TurnState {
    if (isTerminalTurnState(this.#state)) {
      throw new Error(`turn is already terminal (${this.#state}); cannot transition to ${to}`);
    }
    if (!canTransition(this.#state, to)) {
      throw new Error(`illegal turn transition: ${this.#state} -> ${to}`);
    }
    this.#state = to;
    this.#history.push(to);
    return to;
  }

  /** Move to a terminal state with an explicit reason. A turn never ends without naming why (RT-04). */
  terminate(
    state: Extract<
      TurnState,
      'completed' | 'cancelled' | 'failed' | 'blocked' | 'budget-exhausted'
    >,
    reason: TerminationReason,
  ): void {
    this.transition(state);
    this.#reason = reason;
  }
}
