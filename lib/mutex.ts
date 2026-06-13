export class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];
  /** Monotonic counter of completed acquires. Combined with a per-handler
   *  snapshot at enqueue time it lets us compute "how many jobs finished
   *  since I joined" without having to track positions inside the waiters
   *  array. */
  private completedCount = 0;

  /** Number waiting + the one currently running (if any). */
  get pending(): number {
    return this.waiters.length + (this.locked ? 1 : 0);
  }
  /** Number ahead of the next acquirer right now. */
  get waiting(): number {
    return this.waiters.length;
  }
  get completed(): number {
    return this.completedCount;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted before acquire");
    }
    if (this.locked) {
      let myResolver!: () => void;
      try {
        await new Promise<void>((resolve, reject) => {
          myResolver = resolve;
          this.waiters.push(resolve);
          if (signal) {
            const onAbort = () => {
              // Pull ourselves out of waiters[] so a later release()
              // doesn't hand the lock to a dead client and deadlock the
              // queue.
              const idx = this.waiters.indexOf(myResolver);
              if (idx !== -1) this.waiters.splice(idx, 1);
              reject(signal.reason ?? new Error("aborted while queued"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      } catch (e) {
        // If we lost the race between abort and resolve (resolver got
        // shifted off and called just as abort fired), waiters[] no longer
        // has us but the promise already resolved — meaning the lock IS
        // ours. Release it immediately so the next waiter can take it.
        if (this.waiters.indexOf(myResolver) === -1) {
          // Resolver was consumed → we got the slot. Need to "decline" it.
          // Acquire path will set locked below; instead, mark locked then
          // immediately release so completedCount stays sane.
          this.locked = true;
          this.completedCount++;
          this.locked = false;
          const next = this.waiters.shift();
          if (next) next();
        }
        throw e;
      }
    }
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.completedCount++;
      this.locked = false;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
