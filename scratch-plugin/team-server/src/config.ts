import { readFile } from 'node:fs/promises'

let localConfig: Promise<Map<string, string>> | undefined

async function readLocalConfig(): Promise<Map<string, string>> {
  localConfig ??= readFile(new URL('../.env', import.meta.url), 'utf8').then(text => new Map(
    [...text.matchAll(/^([A-Z][A-Z0-9_]*)=(.+)$/gm)].map(match => [match[1]!, match[2]!.trim()]),
  ))
  return localConfig
}

/** Read a Host-only team-server setting from the environment or local config. */
export async function readTeamConfig(name: string): Promise<string> {
  const configured = process.env[`TEAM_${name}`] ?? process.env[name] ?? (await readLocalConfig()).get(name)
  if (!configured) throw new Error(`team-server: ${name} is not configured`)
  return configured
}
