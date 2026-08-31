// git-sync.ts —— 监听工具执行，提取 git 操作与代码变更元数据上传到 server。
// 只传元数据（action/commitHash/stat），命令参数、commit message 不出机器。
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const COMPANY_TOKEN_REF = credentialRef('TEAM_COMPANY_TOKEN')
const run = promisify(execFile)

function gitLog(level: 'info' | 'warn', message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [team-client.git] ${message}`
  if (level === 'warn') console.warn(line)
  else console.info(line)
}

/** git 子命令 → 记录的动作；只读命令（status/diff/log）与未知命令跳过。 */
function classifyGit(command: string): string | undefined {
  const sub = command.replace(/^git\s+/, '').split(/\s+/)[0] ?? ''
  const map: Record<string, string> = {
    commit: 'commit', push: 'push', pull: 'pull', fetch: 'fetch',
    checkout: 'checkout', switch: 'checkout', merge: 'merge', rebase: 'rebase',
    branch: 'branch', stash: 'stash', tag: 'tag', reset: 'reset',
    revert: 'revert', 'cherry-pick': 'cherry-pick', clone: 'clone',
  }
  return map[sub]
}

/** 解析 `git diff-tree --shortstat` 的改动摘要。 */
function parseShortStat(output: string): { files: number; insertions: number; deletions: number } {
  const files = Number(output.match(/(\d+) files? changed/)?.[1] ?? 0)
  const insertions = Number(output.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0)
  const deletions = Number(output.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0)
  return { files, insertions, deletions }
}

/** 订阅工具执行，检测 git 命令并上传操作/变更记录。 */
export function registerGitSync(ctx: Context, serverURL: string): void {
  const authHeaders = async (): Promise<Record<string, string> | undefined> => {
    const credential = await ctx.credentials.resolve(COMPANY_TOKEN_REF)
    if (credential === undefined) return undefined
    return { authorization: `Bearer ${credential.value}`, 'content-type': 'application/json' }
  }

  const captureAndUpload = async (exec: ToolExecution, result: ToolExecutionResult): Promise<void> => {
    try {
      if (exec.name !== 'bash') return
      const args = (exec.arguments ?? {}) as { command?: unknown; workdir?: unknown }
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (!command.startsWith('git ')) return
      const action = classifyGit(command)
      if (action === undefined) return
      const cwd = typeof args.workdir === 'string' && args.workdir !== '' ? args.workdir : undefined
      const sessionId = exec.agent?.session?.id
      const succeeded = !result.isError
      const time = Date.now()
      const headers = await authHeaders()
      if (headers === undefined) return
      gitLog('info', `capture action=${action} cwd=${cwd ?? '?'}`)
      // ① git 操作记录
      await fetch(`${serverURL}/team/api/git/ops`, {
        method: 'POST', headers,
        body: JSON.stringify({ sessionId, ops: [{ action, cwd, time, ...(succeeded ? {} : { failed: true }) }] }),
      }).catch(() => undefined)
      // ② commit 成功 → 代码变更摘要
      if (action === 'commit' && succeeded && cwd !== undefined) {
        const hash = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
        const stat = parseShortStat((await run('git', ['diff-tree', '-r', '--shortstat', 'HEAD'], { cwd })).stdout)
        await fetch(`${serverURL}/team/api/git/changes`, {
          method: 'POST', headers,
          body: JSON.stringify({
            sessionId,
            commits: [{ commitHash: hash, cwd, files: stat.files, insertions: stat.insertions, deletions: stat.deletions, time }],
          }),
        }).catch(() => undefined)
      }
    } catch (error) {
      gitLog('warn', `capture failed: ${String(error)}`)
    }
  }

  // 官方水瀑事件：必须调用 next() 委托；上传 fire-and-forget 不阻塞工具管线。
  ctx.on('tools/post-execute', (exec, result, next) => {
    try {
      void captureAndUpload(exec, result)
    } catch { /* 监听器不抛 */ }
    return next()
  })
}
