import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createLanProxy } from '../scripts/lan-proxy.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected TCP address')
  return address.port
}

describe('LAN proxy', () => {
  it('rejects non-team routes before proxying', async () => {
    const proxy = createLanProxy({ host: '127.0.0.1', port: 3082 })
    const port = await listen(proxy)
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/settings`, {
      headers: { host: '127.0.0.1:3082' },
    })
    expect(response.status).toBe(404)
  })

  it('does not expose the local DSH workspace through the LAN', async () => {
    const proxy = createLanProxy({ host: '127.0.0.1', port: 3082 })
    const port = await listen(proxy)
    const response = await fetch(`http://127.0.0.1:${String(port)}/team/workspace`, {
      headers: { host: '127.0.0.1:3082' },
    })
    expect(response.status).toBe(404)
  })

  it('rejects a foreign Host authority', async () => {
    const proxy = createLanProxy({ host: '127.0.0.1', port: 3082 })
    const port = await listen(proxy)
    const response = await fetch(`http://127.0.0.1:${String(port)}/team/admin`, {
      headers: { host: 'attacker.invalid' },
    })
    expect(response.status).toBe(403)
  })

  it('rejects a cross-site browser request', async () => {
    const proxy = createLanProxy({ host: '127.0.0.1', port: 3082 })
    const port = await listen(proxy)
    const response = await fetch(`http://127.0.0.1:${String(port)}/team/admin`, {
      headers: { host: '127.0.0.1:3082', origin: 'http://evil.invalid', 'sec-fetch-site': 'cross-site' },
    })
    expect(response.status).toBe(403)
  })
})
