import { describe, expect, it } from 'vitest'
import { classifyCommitType, topChangedDirectories } from '../src/project-analytics.ts'

describe('classifyCommitType', () => {
  it('classifies conventional-commit prefixes', () => {
    expect(classifyCommitType('feat: add login page')).toBe('feat')
    expect(classifyCommitType('feat(auth): add sso')).toBe('feat')
    expect(classifyCommitType('fix: null pointer')).toBe('fix')
    expect(classifyCommitType('fix(core): retry')).toBe('fix')
    expect(classifyCommitType('refactor: extract service')).toBe('refactor')
    expect(classifyCommitType('chore: bump deps')).toBe('chore')
    expect(classifyCommitType('docs: update readme')).toBe('docs')
    expect(classifyCommitType('test: cover parser')).toBe('test')
  })

  it('classifies Chinese conventional subjects', () => {
    expect(classifyCommitType('新增用户中心')).toBe('feat')
    expect(classifyCommitType('修复登录超时')).toBe('fix')
    expect(classifyCommitType('重构权限模块')).toBe('refactor')
    expect(classifyCommitType('文档补充架构说明')).toBe('docs')
    expect(classifyCommitType('测试补充边界用例')).toBe('test')
  })

  it('falls back to other for unrelated subjects', () => {
    expect(classifyCommitType('merge branch main')).toBe('other')
    expect(classifyCommitType('update styles')).toBe('other')
    expect(classifyCommitType('')).toBe('other')
    expect(classifyCommitType(undefined)).toBe('other')
  })
})

describe('topChangedDirectories', () => {
  it('groups paths by directory prefix, root files under (根目录)', () => {
    const paths = ['src/app.ts', 'src/app.ts', 'src/lib/util.ts', 'README.md', 'docs/guide.md']
    const result = topChangedDirectories(paths)
    expect(result[0]).toEqual({ directory: 'src', count: 2 })
    expect(result[1]).toEqual({ directory: 'src/lib', count: 1 })
    expect(result[2]).toEqual({ directory: '(根目录)', count: 1 })
    expect(result[3]).toEqual({ directory: 'docs', count: 1 })
  })

  it('respects the top limit and sorts descending', () => {
    const paths = Array.from({ length: 20 }, (_, index) => `dir${index % 5}/file${index}.ts`)
    const result = topChangedDirectories(paths, 3)
    expect(result).toHaveLength(3)
    expect(result[0]!.count).toBeGreaterThanOrEqual(result[1]!.count)
  })
})
