export type TeamUser = {
  id: string
  name: string
}

type SessionResponse = {
  authenticated: boolean
  user?: TeamUser
}

/** Read the current browser session; network failures are treated as signed out. */
export async function currentUser(): Promise<TeamUser | undefined> {
  try {
    const response = await fetch('/team/session')
    const data = await response.json() as SessionResponse
    return response.ok && data.authenticated ? data.user : undefined
  } catch {
    return undefined
  }
}

/** Authenticate with the team server and notify all mounted account views. */
export async function login(userId: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch('/team/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, password }),
    })
    const data = await response.json() as { message?: string }
    if (!response.ok) return { ok: false, message: data.message ?? '登录失败' }
    window.dispatchEvent(new Event('team-auth-changed'))
    return { ok: true }
  } catch {
    return { ok: false, message: '登录请求失败' }
  }
}
