// model-usage.ts —— Model Gateway 用量提取与成本计算。
// 成本按外部规格（DeepSeek 官方公开价，CNY/百万 token）静态计算；
// 平台账号不持有真实价格的部署可用 TEAM_MODEL_PRICES JSON 覆盖。
import { readTeamConfigOptional } from './config.ts'

/** 每百万 token 的 CNY 价格；缓存命中价与未命中价取未命中价（网关不区分缓存态）。 */
export interface ModelPriceCny {
  inputPerMillion: number
  outputPerMillion: number
}

/** DeepSeek 官方公开价（2025-02 版，CNY/百万 token）；未知模型成本记 0。 */
const DEEPSEEK_MODEL_PRICES: Readonly<Record<string, ModelPriceCny>> = {
  'deepseek-chat': { inputPerMillion: 2, outputPerMillion: 8 },
  'deepseek-reasoner': { inputPerMillion: 4, outputPerMillion: 16 },
  'deepseek-v3': { inputPerMillion: 2, outputPerMillion: 8 },
  'deepseek-r1': { inputPerMillion: 4, outputPerMillion: 16 },
}

let overriddenPrices: Record<string, ModelPriceCny> | undefined

/** 一次性解析 TEAM_MODEL_PRICES JSON（部署级覆盖，键为模型 id）。 */
export async function modelPriceOverrides(): Promise<Record<string, ModelPriceCny> | undefined> {
  if (overriddenPrices !== undefined) return overriddenPrices
  const raw = await readTeamConfigOptional('MODEL_PRICES')
  if (raw === undefined) {
    overriddenPrices = undefined
    return undefined
  }
  const parsed = JSON.parse(raw) as unknown
  const result: Record<string, ModelPriceCny> = {}
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('team-server: TEAM_MODEL_PRICES must be a JSON object of model prices')
  }
  for (const [model, value] of Object.entries(parsed)) {
    const price = value as { inputPerMillion?: unknown; outputPerMillion?: unknown }
    if (typeof price.inputPerMillion !== 'number' || typeof price.outputPerMillion !== 'number'
      || !Number.isFinite(price.inputPerMillion) || !Number.isFinite(price.outputPerMillion)
      || price.inputPerMillion < 0 || price.outputPerMillion < 0) {
      throw new Error(`team-server: TEAM_MODEL_PRICES.${model} must be { inputPerMillion, outputPerMillion } non-negative numbers`)
    }
    result[model] = { inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion }
  }
  overriddenPrices = result
  return result
}

/** 计算一次请求的成本（CNY）；未知模型按官方 deepseek-chat 价计。 */
export async function costOf(model: string, inputTokens: number, outputTokens: number): Promise<number> {
  const price = (await modelPriceOverrides())?.[model] ?? DEEPSEEK_MODEL_PRICES[model] ?? DEEPSEEK_MODEL_PRICES['deepseek-chat']!
  return inputTokens / 1_000_000 * price.inputPerMillion + outputTokens / 1_000_000 * price.outputPerMillion
}

export interface UsageTokens {
  inputTokens: number
  outputTokens: number
}

/** 从 OpenAI 兼容 usage 对象提取 input/output token（DeepSeek 用 prompt/completion）。 */
export function usageFromObject(usage: Record<string, unknown> | undefined): UsageTokens | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const input = usage.prompt_tokens ?? usage.input_tokens
  const output = usage.completion_tokens ?? usage.output_tokens
  const total = usage.total_tokens
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  const inputTokens = Math.max(0, Math.trunc(input))
  const outputTokens = Math.max(0, Math.trunc(output))
  if (typeof total === 'number' && total > 0 && inputTokens + outputTokens !== Math.trunc(total)) {
    // 总 token 含 cache hit 等口径差异时以 usage 给出为准；此处仅记录日志不修正。
  }
  return { inputTokens, outputTokens }
}

/** 从一段 SSE 文本中定位 `"usage":{...}`（花括号配平扫描，容忍嵌套）。 */
function findUsageObject(text: string): Record<string, unknown> | undefined {
  const start = text.lastIndexOf('"usage"')
  if (start === -1) return undefined
  const colon = text.indexOf(':', start + '"usage"'.length)
  if (colon === -1) return undefined
  let depth = 0
  let inString = false
  let escape = false
  for (let index = colon + 1; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(colon + 1, index + 1)) as unknown
          return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** 从流式响应体（SSE 文本）提取最后一次出现的 usage。 */
export function usageFromSseText(text: string): UsageTokens | undefined {
  let result: UsageTokens | undefined
  let offset = 0
  while (offset < text.length) {
    const dataIndex = text.indexOf('data:', offset)
    if (dataIndex === -1) break
    const lineEnd = text.indexOf('\n', dataIndex)
    const end = lineEnd === -1 ? text.length : lineEnd
    const line = text.slice(dataIndex + 5, end).trim()
    offset = end + 1
    if (line === '' || line === '[DONE]') continue
    try {
      const payload = JSON.parse(line) as { usage?: Record<string, unknown> }
      const usage = usageFromObject(payload.usage)
      if (usage !== undefined) result = usage
    } catch {
      // 行内 JSON 解析失败：可能被 chunk 截断，由 findUsageObject 兜底扫描全文。
    }
  }
  return result ?? (() => {
    const found = findUsageObject(text)
    return found === undefined ? undefined : usageFromObject(found)
  })()
}
