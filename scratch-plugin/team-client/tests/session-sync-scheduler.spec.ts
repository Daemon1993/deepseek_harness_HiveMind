import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionSyncScheduler } from '../src/session-sync-scheduler.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionSyncScheduler', () => {
  it('coalesces repeated flushes for one Session', async () => {
    vi.useFakeTimers()
    const scheduler = new SessionSyncScheduler(500)
    const runs: number[] = []

    scheduler.schedule('session-a', async () => { runs.push(1) })
    await vi.advanceTimersByTimeAsync(300)
    scheduler.schedule('session-a', async () => { runs.push(2) })
    await vi.advanceTimersByTimeAsync(499)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toEqual([2])

    await scheduler.dispose()
  })

  it('runs once more when a flush arrives during synchronization', async () => {
    const scheduler = new SessionSyncScheduler(500)
    const order: string[] = []
    let releaseFirst!: () => void
    let firstStarted!: () => void
    let latestFinished!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    const finished = new Promise<void>((resolve) => { latestFinished = resolve })

    scheduler.runNow('session-a', async () => {
      order.push('first')
      firstStarted()
      await gate
    })
    await started
    scheduler.schedule('session-a', async () => { order.push('latest') })
    scheduler.schedule('session-a', async () => {
      order.push('latest-again')
      latestFinished()
    })
    releaseFirst()
    await finished
    await scheduler.dispose()

    expect(order).toEqual(['first', 'latest-again'])
  })

  it('keeps unrelated Sessions concurrent', async () => {
    const scheduler = new SessionSyncScheduler(500)
    const order: string[] = []
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const started = new Promise<void>((resolve) => { firstStarted = resolve })

    scheduler.runNow('session-a', async () => {
      order.push('a:start')
      firstStarted()
      await gate
      order.push('a:end')
    })
    await started
    scheduler.runNow('session-b', async () => { order.push('b') })
    await Promise.resolve()
    expect(order).toEqual(['a:start', 'b'])
    releaseFirst()
    await scheduler.dispose()
    expect(order).toEqual(['a:start', 'b', 'a:end'])
  })

  it('retries a failed synchronization until it succeeds', async () => {
    vi.useFakeTimers()
    const scheduler = new SessionSyncScheduler(500, 1_000)
    const outcomes = [false, true]
    const operation = vi.fn(async () => outcomes.shift())

    scheduler.runNow('session-a', operation)
    await vi.advanceTimersByTimeAsync(0)
    expect(operation).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(operation).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(operation).toHaveBeenCalledTimes(2)

    await scheduler.dispose()
  })
})
