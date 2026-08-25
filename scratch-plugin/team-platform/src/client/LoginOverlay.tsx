import { useEffect, useState, type FormEvent } from 'react'

type LoginResponse = {
  message?: string
  user?: {
    id: string
    name: string
  }
}

export function TeamLoginOverlay() {
  const [open, setOpen] = useState(false)
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    function showLogin(): void {
      setMessage('')
      setOpen(true)
    }

    window.addEventListener('team-login-open', showLogin)
    return () => window.removeEventListener('team-login-open', showLogin)
  }, [])

  async function login(event: FormEvent) {
    event.preventDefault()
    setMessage('登录中…')

    try {
      const response = await fetch('/team/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId, password }),
      })

      const data = await response.json() as LoginResponse

      if (!response.ok) {
        setMessage(data.message ?? '登录失败')
        return
      }

      window.dispatchEvent(new Event('team-auth-changed'))
      setOpen(false)
      setPassword('')
    } catch {
      setMessage('登录请求失败')
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="team-login-title"
      style={styles.mask}
    >
      <form onSubmit={login} style={styles.dialog}>
        <h1 id="team-login-title" style={styles.title}>
          团队 AI 平台登录
        </h1>

        <input
          value={userId}
          onChange={event => setUserId(event.target.value)}
          placeholder="用户 ID"
          autoComplete="username"
          required
          style={styles.input}
        />

        <input
          type="password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          placeholder="密码"
          autoComplete="current-password"
          required
          style={styles.input}
        />

        <div style={styles.actions}>
          <button type="button" onClick={() => setOpen(false)} style={styles.cancelButton}>
            取消
          </button>
          <button type="submit" style={styles.button}>
            登录
          </button>
        </div>

        {message && <div style={styles.message}>{message}</div>}
      </form>
    </div>
  )
}

const styles = {
  mask: {
    position: 'fixed',
    inset: 0,
    zIndex: 10000,
    display: 'grid',
    placeItems: 'center',
    background: 'rgba(0, 0, 0, 0.45)',
    pointerEvents: 'auto',
  },
  dialog: {
    width: 360,
    padding: 28,
    borderRadius: 12,
    background: '#fff',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.25)',
  },
  title: {
    margin: '0 0 20px',
    fontSize: 24,
  },
  input: {
    boxSizing: 'border-box',
    width: '100%',
    height: 42,
    marginBottom: 12,
    padding: '0 12px',
  },
  button: {
    flex: 1,
    height: 42,
    border: 0,
    borderRadius: 6,
    color: '#fff',
    background: '#1677ff',
    cursor: 'pointer',
  },
  actions: {
    display: 'flex',
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    height: 42,
    border: '1px solid #d9d9d9',
    borderRadius: 6,
    background: '#fff',
    cursor: 'pointer',
  },
  message: {
    marginTop: 12,
    color: '#d4380d',
  },
} as const
