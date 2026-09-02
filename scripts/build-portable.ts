/** Build the self-contained Windows x64 HiveMind Client archive. */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '..')
const client = join(root, 'scratch-plugin', 'team-client')
const version = JSON.parse(readFileSync(join(client, 'package.json'), 'utf8')).version as string
const name = `HiveMind-Client-v${version}`
const out = join(root, 'dist', name)
let archive = join(root, 'dist', `${name}-win-x64.zip`)
const nodeVersion = process.env.PORTABLE_NODE_VERSION ?? '22.19.0'
const nodeURL = process.env.PORTABLE_NODE_URL ?? `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`
const cache = join(root, '.dsh-build', 'portable-cache')
const buildLock = join(root, '.dsh-build', 'build-portable.lock')
const rootBuildMarker = join(root, '.dsh-build', 'portable-root-build.sha256')

function rootBuildFingerprint(): string {
  const hash = createHash('sha256')
  const ignored = new Set(['node_modules', 'lib', 'dist', 'coverage', '.git'])
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name)) continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else {
        hash.update(child.slice(root.length))
        hash.update(readFileSync(child))
      }
    }
  }
  for (const directory of ['apps', 'packages', 'vendor']) visit(join(root, directory))
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.host.json', 'tsconfig.client.json', 'tsdown.config.ts']) {
    hash.update(file)
    hash.update(readFileSync(join(root, file)))
  }
  return hash.digest('hex')
}

function buildRoot(): void {
  const fingerprint = rootBuildFingerprint()
  const cached = existsSync(rootBuildMarker) && readFileSync(rootBuildMarker, 'utf8').trim() === fingerprint
  const artifactsExist = existsSync(join(root, 'apps', 'cli', 'lib', 'bin.js'))
    && existsSync(join(root, 'packages', 'web', 'frontend', 'dist', 'index.html'))
  if (cached && artifactsExist) {
    console.log('portable: reusing unchanged DSH build')
    return
  }
  run('pnpm', ['run', 'build'])
  writeFileSync(rootBuildMarker, `${rootBuildFingerprint()}\n`)
}

function acquireBuildLock(): () => void {
  mkdirSync(resolve(buildLock, '..'), { recursive: true })
  try {
    mkdirSync(buildLock)
  } catch (error) {
    const ownerFile = join(buildLock, 'pid')
    const owner = existsSync(ownerFile) ? Number(readFileSync(ownerFile, 'utf8')) : Number.NaN
    if (Number.isInteger(owner)) {
      try {
        process.kill(owner, 0)
        throw new Error(`portable: another build is running (PID ${owner})`, { cause: error })
      } catch (ownerError) {
        if (ownerError instanceof Error && ownerError.message.startsWith('portable:')) throw ownerError
      }
    }
    rmSync(buildLock, { recursive: true, force: true })
    mkdirSync(buildLock)
    writeFileSync(ownerFile, String(process.pid))
    return () => rmSync(buildLock, { recursive: true, force: true })
  }
  writeFileSync(join(buildLock, 'pid'), String(process.pid))
  return () => rmSync(buildLock, { recursive: true, force: true })
}

function run(command: string, args: string[], cwd = root, env = process.env): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

function write(path: string, body: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`portable: missing ${label}: ${path}`)
}

function removeFileWithRetries(path: string): boolean {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { force: true })
      return true
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBUSY') throw error
      if (attempt === 19) {
        console.warn(`portable: ${path} is in use; writing a timestamped archive instead`)
        return false
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    }
  }
  return false
}

function requirePhysicalTree(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (lstatSync(child).isSymbolicLink()) throw new Error(`portable: archive input contains a link: ${child}`)
    if (entry.isDirectory()) requirePhysicalTree(child)
  }
}

function clientEnvironment(): string {
  const source = join(client, '.env.client')
  if (!existsSync(source)) throw new Error(`portable: configure ${source} before building`)
  const allowed = new Set(['TEAM_ROLE', 'TEAM_SERVER_URL', 'TEAM_PORT', 'TEAM_GIT_SCAN_MINUTES'])
  const lines = readFileSync(source, 'utf8').split(/\r?\n/u).filter((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line)
    return match !== null && allowed.has(match[1] ?? '')
  })
  if (!lines.some(line => /^TEAM_SERVER_URL=\S+/u.test(line))) {
    throw new Error(`portable: ${source} must define TEAM_SERVER_URL`)
  }
  if (!lines.some(line => line.startsWith('TEAM_PORT='))) lines.push('TEAM_PORT=3080')
  return `${lines.join('\n')}\n`
}

function main(): void {
  rmSync(out, { recursive: true, force: true })
  if (!removeFileWithRetries(archive)) archive = join(root, 'dist', `${name}-win-x64-${Date.now()}.zip`)
  mkdirSync(out, { recursive: true })
  buildRoot()
  run('pnpm', ['run', 'build'], client)
  const app = join(out, 'app')
  run('pnpm', [
    '--config.inject-workspace-packages=true',
    '--config.dangerously-allow-all-builds=true',
    '--config.node-linker=hoisted',
    '--config.package-import-method=copy',
    '--filter', 'dsh-python-runtime-closure', 'deploy', '--offline', '--prod', app,
  ])
  const plugin = join(out, 'template', '.dsh', 'profiles', 'node_modules', 'dsh-team-client')
  mkdirSync(plugin, { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml', 'login.html', 'README.md']) {
    cpSync(join(client, file), join(plugin, file))
  }
  cpSync(join(client, 'lib'), join(plugin, 'lib'), {
    recursive: true,
    filter: source => !source.endsWith('.map'),
  })
  write(join(out, 'config', 'team-client.patch.yml'), '- id: llm-deepseek\n  config:\n    apiKeyEnv: TEAM_COMPANY_TOKEN\n    baseURL: !!js process.env.TEAM_SERVER_URL.replace(/\\/+$/, \'\') + \'/team/api/model\'\n- insert:\n    - id: team-client\n      name: dsh-team-client\n')
  write(join(out, 'config', 'client.env'), clientEnvironment())
  write(join(out, 'start.bat'), '@echo off\r\nsetlocal\r\nset \"ROOT=%~dp0\"\r\nset \"LOG_DIR=%ROOT%logs\"\r\nset \"LOG_FILE=%LOG_DIR%\\startup.log\"\r\nif not exist \"%LOG_DIR%\" mkdir \"%LOG_DIR%\"\r\n>\"%LOG_FILE%\" echo [%date% %time%] HiveMind Client starting\r\nif not exist \"%ROOT%config\\client.env\" (\r\n  >>\"%LOG_FILE%\" echo Missing config\\client.env\r\n  goto failure\r\n)\r\nfor /f \"usebackq tokens=1,* delims==\" %%A in (\"%ROOT%config\\client.env\") do if not \"%%A\"==\"\" set \"%%A=%%B\"\r\nif not defined TEAM_SERVER_URL (\r\n  >>\"%LOG_FILE%\" echo TEAM_SERVER_URL must be set in config\\client.env\r\n  goto failure\r\n)\r\nif not defined TEAM_PORT set \"TEAM_PORT=3080\"\r\nif not exist \"%ROOT%runtime\\node.exe\" (\r\n  >>\"%LOG_FILE%\" echo Missing runtime\\node.exe\r\n  goto failure\r\n)\r\nif not exist \"%ROOT%data\\.dsh\" xcopy \"%ROOT%template\" \"%ROOT%data\" /E /H /I /Q >>\"%LOG_FILE%\" 2>&1\r\nset \"DSH_HOME=%ROOT%data\\.dsh\"\r\necho HiveMind Client is starting on http://127.0.0.1:%TEAM_PORT%\r\necho Startup log: %LOG_FILE%\r\n\"%ROOT%runtime\\node.exe\" \"%ROOT%app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js\" --profile web --patch \"%ROOT%config\\team-client.patch.yml\" --port %TEAM_PORT% >>\"%LOG_FILE%\" 2>&1\r\nset \"EXIT_CODE=%ERRORLEVEL%\"\r\n>>\"%LOG_FILE%\" echo DSH exited with code %EXIT_CODE%\r\n:failure\r\necho.\r\necho HiveMind Client failed to start.\r\necho Log file: %LOG_FILE%\r\necho.\r\ntype \"%LOG_FILE%\"\r\necho.\r\npause\r\nexit /b 1\r\n')
  write(join(out, 'README.md'), '# HiveMind Client\n\nEdit `config/client.env` to set the company Server URL, then double-click `start.bat`. The client keeps login tokens and local sessions in `data/.dsh`; do not copy server credentials into this folder.\n')
  mkdirSync(cache, { recursive: true })
  const zip = join(cache, `node-v${nodeVersion}-win-x64.zip`)
  const runtimeTemp = join(root, 'dist', `.node-${nodeVersion}-win-x64-tmp`)
  if (!existsSync(zip)) {
    run('powershell', ['-NoProfile', '-Command', `Invoke-WebRequest -Uri '${nodeURL}' -OutFile '${zip}'`])
  }
  rmSync(runtimeTemp, { recursive: true, force: true })
  run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${runtimeTemp}' -Force`])
  const nodeRoot = join(runtimeTemp, `node-v${nodeVersion}-win-x64`)
  cpSync(nodeRoot, join(out, 'runtime'), { recursive: true })
  try {
    rmSync(runtimeTemp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
  } catch {
    // Windows virus scanning may transiently retain the extracted executable; it is outside the archive.
  }
  const dshBin = join(app, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  requireFile(dshBin, 'DSH CLI')
  requireFile(join(app, 'node_modules', 'commander', 'package.json'), 'DSH CLI dependency')
  requireFile(join(app, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), 'DSH boot dependency')
  requireFile(join(plugin, 'lib', 'index.mjs'), 'team-client Host bundle')
  requireFile(join(plugin, 'lib', 'client.js'), 'team-client Web bundle')
  requireFile(join(plugin, 'lib', 'login.js'), 'team-client login bundle')
  requireFile(join(out, 'runtime', 'node.exe'), 'embedded Node executable')
  requirePhysicalTree(app)
  run(join(out, 'runtime', 'node.exe'), [dshBin, '--version'])
  run('tar', ['-a', '-cf', archive, '-C', join(root, 'dist'), name])
  run('tar', ['-tf', archive,
    `${name}/start.bat`,
    `${name}/runtime/node.exe`,
    `${name}/app/node_modules/commander/package.json`,
    `${name}/app/node_modules/@deepseek-ai/dsh-app-boot/package.json`,
    `${name}/template/.dsh/profiles/node_modules/dsh-team-client/lib/client.js`,
  ])
  console.log(`portable archive: dist/${archive.slice(join(root, 'dist').length + 1)}`)
}

const releaseBuildLock = acquireBuildLock()
try {
  main()
} finally {
  releaseBuildLock()
}
