/**
 * The stateful bridge from a {@link LiveController} to the pure {@link App} (golden path 8).
 *
 * `App` is deliberately stateless about turns: it renders whatever `source`, `status`, and
 * `approval` it is handed and reports input back through callbacks. This component holds the small
 * amount of React state that the controller drives — the busy/idle status and the pending approval —
 * and forwards every user action (submit, interrupt, approval decision) to the real turn engine
 * behind the controller. Nothing here knows the turn is scripted; it would render a live runtime the
 * same way.
 */

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';

import { App } from './App.tsx';
import type { LiveController } from './scripted-turn.ts';

export function LiveApp({ controller }: { controller: LiveController }): ReactElement {
  const [view, setView] = useState(() => controller.getView());

  useEffect(() => {
    const unsubscribe = controller.subscribeView(() => setView(controller.getView()));
    setView(controller.getView());
    return unsubscribe;
  }, [controller]);

  return (
    <App
      source={controller.source}
      status={view.status}
      approval={view.approval}
      onSubmit={(text) => controller.submit(text)}
      onInterrupt={() => controller.interrupt()}
      onApprovalDecision={(decision) => controller.decide(decision)}
      onCycleMode={() => controller.cycleMode()}
    />
  );
}
