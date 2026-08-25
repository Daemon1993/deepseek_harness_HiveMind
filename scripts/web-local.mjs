/**
 * Boot the Web profile with the repository-local Harness home (`.dsh/`).
 * Loads scratch plugins from `.dsh/profiles/web/cordis.patch.yml` without
 * passing `--patch` on every launch.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const dshHome = join(repoRoot, '.dsh')

console.log(`web:local: DSH_HOME=${dshHome}`)
console.log('web:local: http://127.0.0.1:3080')

const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: dshHome },
  },
)

child.on('exit', (code, signal) => {
  process.exit(signal === null ? code ?? 1 : 1)
})
