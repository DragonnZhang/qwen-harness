import { describe, expect, it } from 'vitest';

import {
  levelOf,
  NotificationQueue,
  STARVATION_THRESHOLD,
  type Notification,
  type NotificationKind,
} from './notifications.ts';

let counter = 0;
function notif(kind: NotificationKind): Notification {
  counter += 1;
  return {
    id: `ntf_${String(counter).padStart(6, '0')}`,
    kind,
    level: levelOf(kind),
    subjectId: 'bgt_1',
    message: kind,
    createdAt: counter,
  };
}

describe('notification priority queue (BG-05)', () => {
  it('delivers a higher-priority item before a lower one already waiting (preemption)', () => {
    const q = new NotificationQueue();
    q.enqueue(notif('background-completion')); // level 3, enqueued first
    q.enqueue(notif('approval')); // level 1, enqueued later

    expect(q.deliver()?.kind).toBe('approval');
    expect(q.deliver()?.kind).toBe('background-completion');
    expect(q.deliver()).toBeNull();
  });

  it('is FIFO within a level', () => {
    const q = new NotificationQueue();
    const a = notif('approval');
    const b = notif('approval');
    q.enqueue(a);
    q.enqueue(b);
    expect(q.deliver()?.id).toBe(a.id);
    expect(q.deliver()?.id).toBe(b.id);
  });

  it(`delivers a waiting lower item after ${STARVATION_THRESHOLD} consecutive higher ones (anti-starvation)`, () => {
    const q = new NotificationQueue();
    q.enqueue(notif('background-completion')); // one waiting level-3 item
    for (let i = 0; i < STARVATION_THRESHOLD + 1; i += 1) q.enqueue(notif('approval')); // level 1

    const delivered = q.drain();
    const levels = delivered.map((n) => n.level);

    // The first ten deliveries are the higher-priority items...
    expect(levels.slice(0, STARVATION_THRESHOLD)).toEqual(Array(STARVATION_THRESHOLD).fill(1));
    // ...then the starved lower-priority item is forced through...
    expect(levels[STARVATION_THRESHOLD]).toBe(3);
    // ...and the remaining higher item follows.
    expect(levels[STARVATION_THRESHOLD + 1]).toBe(1);
  });

  it('maps every kind to the frozen level bands', () => {
    expect(levelOf('input-request')).toBe(1);
    expect(levelOf('task-failure')).toBe(2);
    expect(levelOf('background-completion')).toBe(3);
    expect(levelOf('cron-fire')).toBe(3);
    expect(levelOf('progress')).toBe(4);
  });
});
