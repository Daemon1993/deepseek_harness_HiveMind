// my-tool.ts —— 就这一个文件
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']          // 声明依赖：等 ctx.tools 存在才挂载

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'hello_world',                 // 模型看到的工具名
    description: 'Say hello to someone.', // 模型看到的说明（决定它何时用）
    parameters: {
      who: { type: 'string', required: true, description: 'Who to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `打不死你55555, ${args.who}!`       // args 已被 schema 校验过、类型安全
    },
  }))
}