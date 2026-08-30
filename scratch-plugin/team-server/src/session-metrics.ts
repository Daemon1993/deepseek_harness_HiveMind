// session-metrics.ts —— 从 DSH 会话事件流提取安全的管理指标。
// 只聚合事件元数据，不涉及对话内容/命令参数/文件内容。
type Event = { type?: unknown; time?: unknown; data?: unknown }
type Usage = { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }

export type TimelineKind = 'user' | 'assistant' | 'tool' | 'result' | 'model' | 'turn' | 'step' | 'error'
export type TimelineItem = { time: number; kind: TimelineKind; label: string; status?: 'success' | 'failed' }
export type ToolEvent = { time: number; name: string; failed: boolean; durationMs?: number }
export type ModelEvent = { time: number; model: string; inputTokens: number; outputTokens: number; totalTokens: number }

export interface ToolMetric { name: string; calls: number; failures: number; totalMs: number; avgMs: number; maxMs: number }
export interface ModelMetric { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }

export interface SessionMetrics {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolFailures: number
  turnCount: number
  stepCount: number
  errorCount: number
  /** 会话跨度（首个到末个事件） */
  durationMs: number
  /** 活跃时长（Σ turn 实际工作时间，不含挂机间隔） */
  activeDurationMs: number
  firstTime: number
  lastTime: number
  tools: ToolMetric[]
  models: ModelMetric[]
  timeline: TimelineItem[]
  toolEvents: ToolEvent[]
  modelEvents: ModelEvent[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function metricNumber(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }

function configuredModel(data: Record<string, unknown> | undefined): string {
  const config = record(record(data?.header)?.config)
  const provider = config?.provider
  const model = config?.model
  return typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : '未知模型'
}

function failedToolResult(data: Record<string, unknown> | undefined): boolean {
  return data?.error !== undefined || record(data?.message)?.isError === true
}

/** Extract safe administrative metrics from one durable DSH session event log. */
export function analyzeSessionEvents(events: readonly unknown[]): SessionMetrics {
  const tools = new Map<string, ToolMetric>()
  const models = new Map<string, ModelMetric>()
  const timeline: TimelineItem[] = []
  const toolEvents: ToolEvent[] = []
  const modelEvents: ModelEvent[] = []
  const pendingToolCalls = new Map<string, { event: ToolEvent; name: string }>()
  let currentModel = '未知模型'
  let userMessages = 0; let assistantMessages = 0; let toolCalls = 0; let toolFailures = 0
  let turnCount = 0; let stepCount = 0; let errorCount = 0
  let turnStart: number | undefined
  let activeDurationMs = 0
  let firstTime = Number.POSITIVE_INFINITY; let lastTime = 0

  const touchTime = (time: number): void => {
    if (time < firstTime) firstTime = time
    if (time > lastTime) lastTime = time
  }

  const bumpTool = (name: string, failed: boolean, durationMs: number): void => {
    const item = tools.get(name) ?? { name, calls: 0, failures: 0, totalMs: 0, avgMs: 0, maxMs: 0 }
    item.calls++
    if (failed) item.failures++
    item.totalMs += durationMs
    item.maxMs = Math.max(item.maxMs, durationMs)
    item.avgMs = Math.round(item.totalMs / item.calls)
    tools.set(name, item)
  }

  for (const raw of events) {
    const event = record(raw) as Event | undefined
    if (!event || typeof event.type !== 'string' || typeof event.time !== 'number') continue
    const data = record(event.data)
    touchTime(event.time)
    switch (event.type) {
      case 'request/header':
        currentModel = configuredModel(data)
        timeline.push({ time: event.time, kind: 'model', label: currentModel })
        break
      case 'user/message':
        userMessages++
        timeline.push({ time: event.time, kind: 'user', label: '用户发送消息' })
        break
      case 'assistant/message': {
        assistantMessages++
        const usage = record(data?.usage) as Usage | undefined
        const inputTokens = metricNumber(usage?.inputTokens)
        const outputTokens = metricNumber(usage?.outputTokens)
        const totalTokens = metricNumber(usage?.totalTokens) || inputTokens + outputTokens
        const item = models.get(currentModel) ?? { model: currentModel, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
        item.requests++; item.inputTokens += inputTokens; item.outputTokens += outputTokens; item.totalTokens += totalTokens
        modelEvents.push({ time: event.time, model: currentModel, inputTokens, outputTokens, totalTokens })
        models.set(currentModel, item)
        timeline.push({ time: event.time, kind: 'assistant', label: 'Agent 完成回复' })
        break
      }
      case 'tool/call': {
        const name = typeof data?.name === 'string' ? data.name : 'unknown'
        const toolEvent: ToolEvent = { time: event.time, name, failed: false }
        toolEvents.push(toolEvent)
        if (typeof data?.callId === 'string') pendingToolCalls.set(data.callId, { event: toolEvent, name })
        toolCalls++
        timeline.push({ time: event.time, kind: 'tool', label: name })
        break
      }
      case 'tool/result': {
        const failed = failedToolResult(data)
        const callId = record(data?.message)?.source
        const sourceCallId = record(callId)?.callId
        let durationMs = 0
        let name = 'unknown'
        if (typeof sourceCallId === 'string') {
          const pending = pendingToolCalls.get(sourceCallId)
          if (pending !== undefined) {
            pending.event.failed = failed
            pending.event.durationMs = Math.max(0, event.time - pending.event.time)
            durationMs = pending.event.durationMs
            name = pending.name
            pendingToolCalls.delete(sourceCallId)
          }
        }
        bumpTool(name, failed, durationMs)
        if (failed) toolFailures++
        timeline.push({ time: event.time, kind: 'result', label: failed ? '工具执行失败' : '工具执行完成', status: failed ? 'failed' : 'success' })
        break
      }
      case 'turn/start':
        turnCount++
        turnStart = event.time
        timeline.push({ time: event.time, kind: 'turn', label: `Turn ${turnCount}` })
        break
      case 'turn/end':
        if (turnStart !== undefined) {
          activeDurationMs += Math.max(0, event.time - turnStart)
          turnStart = undefined
        }
        break
      case 'step/start':
        stepCount++
        timeline.push({ time: event.time, kind: 'step', label: `Step ${stepCount}` })
        break
      default:
        if (data?.error !== undefined) {
          errorCount++
          timeline.push({ time: event.time, kind: 'error', label: '错误', status: 'failed' })
        }
    }
  }

  const durationMs = lastTime > 0 && firstTime !== Number.POSITIVE_INFINITY
    ? Math.max(0, lastTime - firstTime)
    : 0

  return {
    userMessages,
    assistantMessages,
    toolCalls,
    toolFailures,
    turnCount,
    stepCount,
    errorCount,
    durationMs,
    activeDurationMs: activeDurationMs + (turnStart === undefined ? 0 : Math.max(0, lastTime - turnStart)),
    firstTime: firstTime === Number.POSITIVE_INFINITY ? 0 : firstTime,
    lastTime,
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
    models: [...models.values()].sort((a, b) => b.requests - a.requests),
    timeline,
    toolEvents,
    modelEvents,
  }
}
