export interface TeamUser {
  id: string
  name: string
}

interface SessionResponse {
  authenticated: boolean
  user?: TeamUser
}

export type TeamSessionState =
  | { reachable: false }
  | { reachable: true; user?: TeamUser }

/** Read the current browser session while distinguishing a missing team server. */
export async function currentSession(): Promise<TeamSessionState> {
  try {
    const response = await fetch('/team/session', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.headers.get('content-type')?.includes('application/json')) return { reachable: false }
    const data = await response.json() as SessionResponse
    if (!response.ok) return { reachable: false }
    return data.authenticated && data.user !== undefined
      ? { reachable: true, user: data.user }
      : { reachable: true }
  } catch {
    return { reachable: false }
  }
}

/** End the current browser session and notify all mounted account views. */
export async function logout(): Promise<boolean> {
  try {
    const response = await fetch('/team/logout', { method: 'POST', credentials: 'same-origin' })
    if (!response.ok) return false
    window.dispatchEvent(new Event('team-auth-changed'))
    return true
  } catch {
    return false
  }
}
