import type { TeamAuditLogInput, TeamLogRecord } from './types.ts'

/** Write one readable operational log line and return its structured record. */
export function writeTeamLog(input: string | TeamAuditLogInput): TeamLogRecord {
  const entry: TeamAuditLogInput = typeof input === 'string'
    ? { level: 'info', event: 'application.log', message: input }
    : input
  const record: TeamLogRecord = {
    timestamp: new Date().toISOString(),
    service: 'team-server',
    source: callerSource(),
    ...entry,
    message: entry.message ?? entry.event,
  }
  const context = [record.userId && `user=${record.userId}`, record.sessionId && `session=${record.sessionId}`, record.model && `model=${record.model}`]
    .filter(Boolean)
    .join(' ')
  const line = `${record.timestamp} ${record.level.toUpperCase().padEnd(5)} [${record.service}] ${record.source} - ${record.message}${context ? ` (${context})` : ''}`
  if (entry.level === 'error') console.error(line)
  else if (entry.level === 'warn') console.warn(line)
  else console.info(line)
  return record
}

function callerSource(): string {
  const frames = new Error().stack?.split('\n').slice(1) ?? []
  const ownFrame = frames.find(frame => (frame.includes('/scratch-plugin/team-server/')
    || frame.includes('\\scratch-plugin\\team-server\\')) && !frame.includes('team-log.')
    && !frame.includes('TeamService.audit') && !frame.includes('Proxy.audit'))
  const caller = ownFrame ?? frames.find(frame => !frame.includes('team-log.'))
  if (caller === undefined) return 'unknown'
  const location = caller.match(/[\\/]scratch-plugin[\\/]team-server[\\/](src[\\/].+?):(\d+):\d+\)?$/)
  const source = location?.[1]
  const line = location?.[2]
  return source === undefined || line === undefined
    ? caller.trim().replace(/^at\s+/, '')
    : `${source.replaceAll('\\', '/')}:${line}`
}
