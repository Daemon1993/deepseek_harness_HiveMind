type Event = { type?: unknown; time?: unknown; data?: unknown }
type Usage = { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }

export type TimelineItem = { time: number; kind: 'user' | 'assistant' | 'tool' | 'result' | 'model'; label: string; status?: 'success' | 'failed' }
export type ToolEvent = { time: number; name: string; failed: boolean }
export type ModelEvent = { time: number; model: string; inputTokens: number; outputTokens: number; totalTokens: number }

type ToolMetric = { name: string; calls: number; failures: number }
type ModelMetric = { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }

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
export function analyzeSessionEvents(events: readonly unknown[]) {
  const tools = new Map<string, ToolMetric>()
  const models = new Map<string, ModelMetric>()
  const timeline: TimelineItem[] = []
  const toolEvents: ToolEvent[] = []
  const modelEvents: ModelEvent[] = []
  const pendingToolCalls = new Map<string, ToolEvent>()
  let currentModel = '未知模型'; let userMessages = 0; let assistantMessages = 0; let toolCalls = 0; let toolFailures = 0
  for (const raw of events) {
    const event = record(raw) as Event | undefined; if (!event || typeof event.type !== 'string' || typeof event.time !== 'number') continue
    const data = record(event.data)
    if (event.type === 'request/header') { currentModel = configuredModel(data); timeline.push({ time: event.time, kind: 'model', label: currentModel }); continue }
    if (event.type === 'user/message') { userMessages++; timeline.push({ time: event.time, kind: 'user', label: '用户发送消息' }); continue }
    if (event.type === 'assistant/message') {
      assistantMessages++
      const usage = record(data?.usage) as Usage | undefined
      const inputTokens = metricNumber(usage?.inputTokens); const outputTokens = metricNumber(usage?.outputTokens); const totalTokens = metricNumber(usage?.totalTokens) || inputTokens + outputTokens
        const item = models.get(currentModel) ?? { model: currentModel, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
        item.requests++; item.inputTokens += inputTokens; item.outputTokens += outputTokens; item.totalTokens += totalTokens
        modelEvents.push({ time: event.time, model: currentModel, inputTokens, outputTokens, totalTokens })
        models.set(currentModel, item); timeline.push({ time: event.time, kind: 'assistant', label: 'Agent 完成回复' }); continue
    }
    if (event.type === 'tool/call') {
      const name = typeof data?.name === 'string' ? data.name : 'unknown'; const item = tools.get(name) ?? { name, calls: 0, failures: 0 }
      const toolEvent = { time: event.time, name, failed: false }
      item.calls++; tools.set(name, item); toolEvents.push(toolEvent)
      if (typeof data?.callId === 'string') pendingToolCalls.set(data.callId, toolEvent)
      toolCalls++; timeline.push({ time: event.time, kind: 'tool', label: name }); continue
    }
    if (event.type === 'tool/result') {
      const failed = failedToolResult(data); const callId = record(data?.message)?.source; const sourceCallId = record(callId)?.callId
      if (failed) {
        toolFailures++
        if (typeof sourceCallId === 'string') {
          const call = pendingToolCalls.get(sourceCallId)
          if (call !== undefined) { call.failed = true; const metric = tools.get(call.name); if (metric !== undefined) metric.failures++ }
        }
      }
      timeline.push({ time: event.time, kind: 'result', label: failed ? '工具执行失败' : '工具执行完成', status: failed ? 'failed' : 'success' })
    }
  }
  return { userMessages, assistantMessages, toolCalls, toolFailures, tools: [...tools.values()], models: [...models.values()], toolEvents, modelEvents, timeline }
}
