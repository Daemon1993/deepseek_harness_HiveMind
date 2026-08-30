// reconcile.ts —— 会话对账：以文件为权威，修正 PG 归属/标记的漂移。
// 规则：PG 有行但文件不存在 → 删除；文件存在但 PG 无行 → 孤儿（记录，不删文件）；
//       标记（md5/size）与文件不符 → 以文件重建。
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TeamContext } from './types.ts'
import { writeTeamLog } from './team-log.ts'

export interface ReconcileResult {
  checked: number
  deleted: string[]
  orphans: string[]
  repaired: string[]
}

/** 扫描持久化根，返回存在的会话文件路径（sessionId -> path）。 */
async function scanSessionFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const workspaces = await readdir(root).catch(() => [])
  for (const ws of workspaces) {
    const sessions = await readdir(join(root, ws)).catch(() => [])
    for (const dir of sessions) {
      const file = join(root, ws, dir, 'session.jsonl.zstd')
      if ((await stat(file).catch(() => undefined)) !== undefined) files.set(dir, file)
    }
  }
  return files
}

async function md5File(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('md5').update(bytes).digest('hex')
}

/** 对账：扫描文件 → 与 PG 比对 → 修正漂移。 */
export async function reconcileSessions(ctx: TeamContext): Promise<ReconcileResult> {
  // 具体后端暴露 config.root；抽象类型未声明，运行时取。
  const root = (ctx.sessionPersistence as unknown as { config?: { root: string } }).config?.root
  if (root === undefined) throw new Error('session persistence root unavailable')
  const result: ReconcileResult = { checked: 0, deleted: [], orphans: [], repaired: [] }
  const files = await scanSessionFiles(root)
  result.checked = files.size
  const rows = await ctx.team.listSyncStatus()
  const rowIds = new Set(rows.map(row => row.sessionId))
  // a. PG 有行、文件不存在 → 删除（文件是存在性的权威）
  for (const row of rows) {
    if (!files.has(row.sessionId)) {
      await ctx.team.deleteSyncedSession(row.sessionId)
      result.deleted.push(row.sessionId)
    }
  }
  // b. 文件存在、PG 无行 → 孤儿：无法定归属，记录但不删文件
  for (const sessionId of files.keys()) {
    if (!rowIds.has(sessionId)) result.orphans.push(sessionId)
  }
  // c. 标记与文件不符 → 以文件重建（md5 + size）
  for (const row of rows) {
    const file = files.get(row.sessionId)
    if (file === undefined) continue
    const [size, md5] = await Promise.all([stat(file).then(info => info.size), md5File(file)])
    const marker = await ctx.team.readSessionMarker(row.sessionId)
    if (marker === undefined || marker.fileSize !== size || marker.contentMd5 !== md5) {
      await ctx.team.markSessionSynced(row.sessionId, md5, size)
      result.repaired.push(row.sessionId)
    }
  }
  writeTeamLog({
    level: 'info', event: 'session.reconcile',
    message: `reconcile done checked=${result.checked} deleted=${result.deleted.length} orphans=${result.orphans.length} repaired=${result.repaired.length}`,
  })
  return result
}
