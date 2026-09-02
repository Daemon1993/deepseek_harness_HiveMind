import { readFile } from 'node:fs/promises'

let localConfig: Promise<Map<string, string>> | undefined

async function readLocalConfig(): Promise<Map<string, string>> {
  localConfig ??= Promise.all(['.env', '.env.server'].map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8').catch(() => ''))).then(files => {
    const values = new Map<string, string>()
    for (const text of files) for (const match of text.matchAll(/^([A-Z][A-Z0-9_]*)=(.+)$/gm)) values.set(match[1]!, match[2]!.trim())
    return values
  })
  return localConfig
}

/** Read a Host-only team-server setting from the environment or local config. */
export async function readTeamConfig(name: string): Promise<string> {
  const configured = await readTeamConfigOptional(name)
  if (configured === undefined) throw new Error(`team-server: ${name} is not configured`)
  return configured
}

/** Read an optional team-server setting; undefined when absent everywhere. */
export async function readTeamConfigOptional(name: string): Promise<string | undefined> {
  const local = await readLocalConfig()
  return process.env[`TEAM_${name}`] ?? process.env[name] ?? local.get(`TEAM_${name}`) ?? local.get(name)
}
