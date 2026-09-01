const BASE = 'http://127.0.0.1:3081'
const login = await fetch(`${BASE}/team/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'liu', password: '123456' }) })
const loginBody = await login.json()
if (loginBody.token === undefined) { console.log('login failed'); process.exit(1) }
const token = loginBody.token

const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')
const run = promisify(execFile)
const ROOT = 'E:/dp_harness/deepseek-harness'
const gitScan = async (args) => (await run('git', ['-C', ROOT, ...args], { maxBuffer: 512 * 1024 * 1024 })).stdout.trim()
const { parseLogMetadata, parseNameStatus, parseShortStatLog } = await import('./src/git-sync.ts')
const [metadata, nameStatus, shortStat] = await Promise.all([
  gitScan(['log', '--all', '--format=%H%x00%an%x00%ae%x00%B%x00%ct']),
  gitScan(['log', '--all', '--format=%H', '--name-status', '--no-renames']),
  gitScan(['log', '--all', '--format=%H', '--shortstat']),
])
const meta = parseLogMetadata(metadata)
const paths = parseNameStatus(nameStatus)
const stats = parseShortStatLog(shortStat)
const gitRemote = (await run('git', ['-C', ROOT, 'remote', 'get-url', 'origin']).catch(() => ({ stdout: '' }))).stdout.trim() || undefined
const commits = [...meta.entries()].map(([hash, record]) => ({
  commitHash: hash, cwd: ROOT,
  ...(gitRemote === undefined ? {} : { gitRemote }),
  authorName: record.authorName, authorEmail: record.authorEmail,
  subject: record.message.split('\n')[0]?.trim() ?? '', message: record.message,
  changedFiles: (paths.get(hash) ?? []).slice(0, 200),
  files: stats.get(hash)?.files ?? 0, insertions: stats.get(hash)?.insertions ?? 0, deletions: stats.get(hash)?.deletions ?? 0,
  time: record.time,
}))
console.log('total commits:', commits.length, 'batches:', Math.ceil(commits.length / 100))
let ok = 0
for (let offset = 0; offset < commits.length; offset += 100) {
  const batch = commits.slice(offset, offset + 100)
  const res = await fetch(`${BASE}/team/api/git/changes`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ commits: batch }),
  })
  const text = await res.text()
  if (res.ok) { ok++; continue }
  console.log(`FAIL batch #${offset / 100 + 1} (offset=${offset}) status=${res.status} body=${text.slice(0, 300)}`)
  console.log('first commit in batch:', JSON.stringify(batch[0]).slice(0, 200))
  process.exit(1)
}
console.log('all', ok, 'batches ok')
