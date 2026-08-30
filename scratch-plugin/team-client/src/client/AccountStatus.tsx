import { useCallback, useEffect, useState } from 'react'
import { currentSession, logout, type TeamSessionState } from './auth.ts'

/** Employee identity and sign-out contribution shown above the DSH settings row. */
export function AccountStatus() {
  const [session, setSession] = useState<TeamSessionState>({ reachable: false })
  const [checked, setChecked] = useState(false)

  const refresh = useCallback(async () => {
    setSession(await currentSession())
    setChecked(true)
  }, [])

  useEffect(() => {
    void refresh()
    window.addEventListener('team-auth-changed', refresh)
    return () => { window.removeEventListener('team-auth-changed', refresh) }
  }, [refresh])

  useEffect(() => {
    if (checked && session.reachable && session.user === undefined) window.location.replace('/team/login-page')
  }, [checked, session])

  const user = session.reachable ? session.user : undefined

  return <div style={styles.account}>
    <button
      type="button"
      disabled={!session.reachable}
      onClick={() => user === undefined
        ? window.location.assign('/team/login-page')
        : window.open('/team/admin', '_blank', 'noopener,noreferrer')}
      style={{
        ...styles.identity,
        cursor: session.reachable ? 'pointer' : 'default',
        opacity: session.reachable ? 1 : 0.65,
      }}
    >
      <span>{user === undefined ? '○' : '👤'}</span>
      <span>{user?.name ?? (session.reachable ? '未登录' : '服务未连接')}</span>
    </button>
    {user !== undefined && <button
      type="button"
      onClick={() => { void logout().then(ok => { if (ok) window.location.replace('/team/login-page') }) }}
      style={styles.logout}
    >退出登录</button>}
  </div>
}

const styles = {
  account: { display: 'flex', alignItems: 'center', width: '100%' },
  identity: {
    display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1,
    padding: '8px 12px', border: 0, background: 'transparent', cursor: 'pointer',
    fontSize: 14, textAlign: 'left',
  },
  logout: {
    padding: '4px 8px', border: 0, background: 'transparent', color: '#6b7280',
    cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
  },
} as const
