/** What one holder of the lock did: who it was, how long it waited, and how long it held the desktop's input. */
export interface InputLockEntry {
  /** The run's cursor agent id, or another short id. Never a name or a label. */
  owner: string;
  waitedMs: number;
  heldMs: number;
}

/**
 * Sole use of the desktop's input, one step at a time, first come first served. Runs can overlap, but their focus
 * changes, key presses and menu clicks cannot: a step takes the lock for its action and its postcondition, then the next
 * step in line gets it. A step that throws still releases the lock. Nothing here times out; each step's own calls do.
 */
export class InputLock {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly record?: (entry: InputLockEntry) => void) {}

  run<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const queued = Date.now();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    return previous.then(async () => {
      const entered = Date.now();
      try {
        return await work();
      } finally {
        const done = Date.now();
        release();
        try {
          this.record?.({ owner, waitedMs: entered - queued, heldMs: done - entered });
        } catch {
          // The log is best effort. A failing log must not keep the lock.
        }
      }
    });
  }
}
