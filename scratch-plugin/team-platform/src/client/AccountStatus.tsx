import { useCallback, useEffect, useState } from 'react'
import { currentUser, type TeamUser } from './auth.ts'

export function AccountStatus() {
  const [user, setUser] = useState<TeamUser>()

  const refresh = useCallback(async () => {
    setUser(await currentUser())
  }, [])

  useEffect(() => {
    void refresh()

    window.addEventListener('team-auth-changed', refresh)

    return () => {
      window.removeEventListener('team-auth-changed', refresh)
    }
  }, [refresh])

  function openLogin(): void {
    if (user) return
    window.dispatchEvent(new Event('team-login-open'))
  }

  return (
    <button type="button" onClick={openLogin} style={styles.account}>
      <span>{user ? '👤' : '○'}</span>
      <span>{user?.name ?? '未登录'}</span>
    </button>
  )
}

const styles = {
  account: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 12px',
    border: 0,
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 14,
    textAlign: 'left',
  },
} as const
