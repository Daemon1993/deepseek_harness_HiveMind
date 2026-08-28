import { useCallback, useEffect, useState } from 'react'
import { currentUser, logout, type TeamUser } from './auth.ts'

export function AccountStatus() {
  const [user, setUser] = useState<TeamUser>()
  const [checked, setChecked] = useState(false)

  const refresh = useCallback(async () => {
    const authenticated = await currentUser()
    setUser(authenticated)
    setChecked(true)
  }, [])

  useEffect(() => {
    void refresh()

    window.addEventListener('team-auth-changed', refresh)

    return () => {
      window.removeEventListener('team-auth-changed', refresh)
    }
  }, [refresh])

  useEffect(() => {
    if (checked && user === undefined) window.location.replace('/team/login-page')
  }, [checked, user])

  function openLogin(): void {
    if (user) return
    window.location.assign('/team/login-page')
  }

  function openAdmin(): void {
    window.open('/team/admin', '_blank', 'noopener,noreferrer')
  }

  async function signOut(): Promise<void> {
    if (await logout()) window.location.replace('/team/login-page')
  }

  return (
    <div style={styles.account}>
      <button type="button" onClick={user ? openAdmin : openLogin} style={styles.identity}>
        <span>{user ? '👤' : '○'}</span>
        <span>{user?.name ?? '未登录'}</span>
      </button>
      {user && <button type="button" onClick={() => void signOut()} style={styles.logout}>退出登录</button>}
    </div>
  )
}

const styles = {
  account: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
  },
  identity: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    flex: 1,
    padding: '8px 12px',
    border: 0,
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 14,
    textAlign: 'left',
  },
  logout: {
    padding: '4px 8px',
    border: 0,
    background: 'transparent',
    color: '#6b7280',
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap',
  },
} as const
