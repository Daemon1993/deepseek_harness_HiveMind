type SessionSyncState = {
  dirty: boolean
  operation: () => Promise<boolean | void>
  running: Promise<void> | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Coalesce Session flushes and preserve one trailing run after in-flight changes. */
export class SessionSyncScheduler {
  private readonly states = new Map<string, SessionSyncState>()
  private disposed = false

  /**
   * @param delayMs - quiet period before a scheduled synchronization starts.
   */
  constructor(
    private readonly delayMs: number,
    private readonly retryDelayMs = 10_000,
  ) {}

  /**
   * Schedule the latest operation for one Session after the quiet period.
   * @param sessionId - Session whose flushes share one timer and run.
   * @param operation - synchronization that reads the latest durable file.
   */
  schedule(sessionId: string, operation: () => Promise<boolean | void>): void {
    if (this.disposed) return
    const state = this.ensure(sessionId, operation)
    state.operation = operation
    if (state.running !== undefined) {
      state.dirty = true
      return
    }
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = undefined
      this.start(sessionId, state)
    }, this.delayMs)
  }

  /**
   * Start synchronization without waiting for the debounce interval.
   * @param sessionId - Session whose pending timer is consumed.
   * @param operation - synchronization that reads the latest durable file.
   */
  runNow(sessionId: string, operation: () => Promise<boolean | void>): void {
    if (this.disposed) return
    const state = this.ensure(sessionId, operation)
    state.operation = operation
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    if (state.running !== undefined) {
      state.dirty = true
      return
    }
    this.start(sessionId, state)
  }

  /** Cancel pending timers and wait until started synchronizations settle. */
  async dispose(): Promise<void> {
    this.disposed = true
    const running: Promise<void>[] = []
    for (const state of this.states.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer)
      if (state.running !== undefined) running.push(state.running)
    }
    await Promise.allSettled(running)
    this.states.clear()
  }

  private ensure(sessionId: string, operation: () => Promise<boolean | void>): SessionSyncState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = { dirty: false, operation, running: undefined, timer: undefined }
      this.states.set(sessionId, state)
    }
    return state
  }

  private start(sessionId: string, state: SessionSyncState): void {
    let retry = false
    const running = this.drain(state).then((completed) => {
      retry = !completed
    }, () => {
      retry = true
    }).finally(() => {
      if (state.running === running) state.running = undefined
      if (this.disposed || state.running !== undefined || state.timer !== undefined || state.dirty) return
      if (!retry) {
        this.states.delete(sessionId)
        return
      }
      state.timer = setTimeout(() => {
        state.timer = undefined
        this.start(sessionId, state)
      }, this.retryDelayMs)
    })
    state.running = running
  }

  private async drain(state: SessionSyncState): Promise<boolean> {
    let completed = true
    do {
      state.dirty = false
      completed = (await state.operation()) !== false
    } while (!this.disposed && state.dirty)
    return completed
  }
}
