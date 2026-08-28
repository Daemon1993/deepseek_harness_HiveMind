import { useEffect, useState, type FormEvent } from 'react'
import { login as submitLogin } from './auth.ts'

export function TeamLoginOverlay() {
  const [open, setOpen] = useState(false)
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [applying, setApplying] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')

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
    if (applying) {
      setMessage('提交中…')
      try {
        const response = await fetch('/team/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name }) })
        const data = await response.json() as { message?: string }
        setMessage(data.message ?? (response.ok ? '申请已提交' : '申请失败'))
        if (response.ok) { setApplying(false); setEmail(''); setName('') }
      } catch { setMessage('申请请求失败') }
      return
    }
    setMessage('登录中…')

    const result = await submitLogin(userId, password)
    if (!result.ok) {
      setMessage(result.message)
      return
    }
    setOpen(false)
    setPassword('')
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
          {applying ? '申请使用团队 AI 平台' : '团队 AI 平台登录'}
        </h1>

        {applying ? <>
          <input value={email} onChange={event => setEmail(event.target.value)} placeholder="邮箱" type="email" required style={styles.input} />
          <input value={name} onChange={event => setName(event.target.value)} placeholder="真实姓名" required style={styles.input} />
        </> : <>

        <input
          value={userId}
          onChange={event => setUserId(event.target.value)}
          placeholder="用户 ID"
          autoComplete="username"
          required
          style={styles.input}
        />
        </>}

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
            {applying ? '提交申请' : '登录'}
          </button>
        </div>

        <button type="button" onClick={() => { setApplying(value => !value); setMessage('') }} style={styles.linkButton}>
          {applying ? '返回登录' : '申请使用'}
        </button>

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
  linkButton: {
    marginTop: 12,
    border: 0,
    background: 'transparent',
    color: '#1677ff',
    cursor: 'pointer',
  },
} as const
