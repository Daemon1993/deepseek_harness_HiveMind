import { describe, expect, it } from 'vitest'
import { parseLogMetadata, parseNameStatus, parseShortStatLog } from '../src/git-sync.ts'

describe('parseLogMetadata', () => {
  it('parses commit metadata records with multi-line messages', () => {
    const output = [
      'bd1910c300950f68e234fe3af85a10cd65b67ad4\x00Test\x00test@example.com\x00feat: add login\n\nbody line 1\nbody line 2\x001788223439',
      'd835611132285ad54938798c86f663b8aec8a425\x00Test\x00test@example.com\x00first\x001788223431',
    ].join('\n')
    const records = parseLogMetadata(output)
    expect(records.size).toBe(2)
    expect(records.get('d835611132285ad54938798c86f663b8aec8a425')).toEqual({
      authorName: 'Test',
      authorEmail: 'test@example.com',
      message: 'first',
      time: 1_788_223_431_000,
    })
    expect(records.get('bd1910c300950f68e234fe3af85a10cd65b67ad4')?.message).toBe('feat: add login\n\nbody line 1\nbody line 2')
  })

  it('drops a pathological message whose line looks like a record boundary', () => {
    // 整行 40 位 hex 紧跟时间戳分隔符的消息与真实记录边界不可区分：
    // 解析器按时间戳校验丢弃由此产生的残缺记录，绝不产生脏数据。
    const output = 'bd1910c300950f68e234fe3af85a10cd65b67ad4\x00A\x00a@b.c\x00hashlike\nbd1910c300950f68e234fe3af85a10cd65b67ad4\x001\x00'
    expect(parseLogMetadata(output).size).toBe(0)
  })

  it('returns an empty map for empty output', () => {
    expect(parseLogMetadata('').size).toBe(0)
  })
})

describe('parseNameStatus', () => {
  it('maps each commit to its changed file paths', () => {
    const output = [
      'bd1910c300950f68e234fe3af85a10cd65b67ad4',
      '',
      'M\tsrc/app.ts',
      'A\tsrc/lib/util.ts',
      '',
      'd835611132285ad54938798c86f663b8aec8a425',
      '',
      'A\tf.txt',
      '',
    ].join('\n')
    const records = parseNameStatus(output)
    expect(records.get('bd1910c300950f68e234fe3af85a10cd65b67ad4')).toEqual(['src/app.ts', 'src/lib/util.ts'])
    expect(records.get('d835611132285ad54938798c86f663b8aec8a425')).toEqual(['f.txt'])
  })
})

describe('parseShortStatLog', () => {
  it('maps each commit to its change counts', () => {
    const output = [
      'bd1910c300950f68e234fe3af85a10cd65b67ad4',
      '',
      ' 2 files changed, 2 insertions(+)',
      '',
      'd835611132285ad54938798c86f663b8aec8a425',
      '',
      ' 1 file changed, 1 deletion(-)',
      '',
    ].join('\n')
    const records = parseShortStatLog(output)
    expect(records.get('bd1910c300950f68e234fe3af85a10cd65b67ad4')).toEqual({ files: 2, insertions: 2, deletions: 0 })
    expect(records.get('d835611132285ad54938798c86f663b8aec8a425')).toEqual({ files: 1, insertions: 0, deletions: 1 })
  })

  it('skips commits without a stat line', () => {
    const output = 'bd1910c300950f68e234fe3af85a10cd65b67ad4\n\n'
    expect(parseShortStatLog(output).size).toBe(0)
  })
})
