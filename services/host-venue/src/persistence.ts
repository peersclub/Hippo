/**
 * Debounced snapshot persistence for the venue's book of record.
 *
 * Coalescing shape: the FIRST mutation after a quiet period arms one timer;
 * every mutation landing inside the window rides along for free because the
 * snapshot is serialized at FIRE time, not at schedule time. A burst of rapid
 * mutations therefore costs one write, and sustained order flow costs at most
 * one write per window. (A pure trailing debounce that re-arms on every event
 * would never save under continuous flow — the wrong failure mode for a book
 * of record.)
 *
 * Saves are strictly fire-and-forget: a slow or failing database must NEVER
 * block or fail a trade path, so errors land in `onError` (a log line), never
 * a throw into the caller.
 */
export class SnapshotPersister {
  private timer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<void> = Promise.resolve()

  constructor(
    private readonly save: () => Promise<void>,
    private readonly onError: (err: unknown) => void,
    private readonly delayMs = 1_000,
  ) {}

  /** Call on every store mutation. Cheap: arms at most one pending timer. */
  schedule(): void {
    if (this.timer) return
    const t = setTimeout(() => {
      this.timer = null
      this.inflight = this.save().catch(this.onError)
    }, this.delayMs)
    // Never keep the process alive just to save — flush() covers shutdown.
    t.unref?.()
    this.timer = t
  }

  /** Graceful shutdown: run any pending save now and wait for it. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.inflight = this.save().catch(this.onError)
    }
    await this.inflight
  }
}
