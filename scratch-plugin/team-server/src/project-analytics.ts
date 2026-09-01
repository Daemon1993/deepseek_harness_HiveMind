// project-analytics.ts —— 项目维度的纯计算：Commit 类型分类与活跃目录聚合。
// 规则优先（方案 §7），不依赖 LLM；服务端与 UI 共用同一分类口径。

export type CommitType = 'feat' | 'fix' | 'refactor' | 'chore' | 'docs' | 'test' | 'other'

/** 规则优先的 Commit 类型分类（feat/fix/refactor/chore/docs/test）。 */
export function classifyCommitType(subject: string | undefined): CommitType {
  const text = (subject ?? '').trim().toLowerCase()
  if (text === '') return 'other'
  if (/^(feat|feature)(\(|\s*[:：])/u.test(text) || text.startsWith('新增')) return 'feat'
  if (/^fix(\(|\s*[:：])/u.test(text) || /^bugfix/u.test(text) || text.startsWith('修复')) return 'fix'
  if (/^refactor(\(|\s*[:：])/u.test(text) || text.startsWith('重构')) return 'refactor'
  if (/^chore(\(|\s*[:：])/u.test(text)) return 'chore'
  if (/^docs(\(|\s*[:：])/u.test(text) || text.startsWith('文档')) return 'docs'
  if (/^test(\(|\s*[:：])/u.test(text) || text.startsWith('测试')) return 'test'
  return 'other'
}

/** 按目录前缀统计近期高频变更区域（方案 §7 活跃目录/文件）。 */
export function topChangedDirectories(paths: readonly string[], top = 10): { directory: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(根目录)'
    counts.set(directory, (counts.get(directory) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([directory, count]) => ({ directory, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top)
}
