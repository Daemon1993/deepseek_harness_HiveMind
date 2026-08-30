import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp, Button, Card, ConfigProvider, Form, Input, Typography } from 'antd'

/** 管理端登录：浅色居中单卡片，仅登录，无员工申请流程。 */
function LoginApp() {
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    void fetch('/team/session').then(async response => {
      const data = await response.json() as { authenticated?: boolean }
      if (response.ok && data.authenticated) window.location.replace('/team/admin')
    }).catch(() => undefined)
  }, [])

  async function submit(values: Record<string, string>): Promise<void> {
    setSubmitting(true)
    setMessage('')
    try {
      const response = await fetch('/team/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      })
      const data = await response.json() as { message?: string }
      if (!response.ok) { setMessage(data.message ?? '登录失败'); return }
      window.location.replace('/team/admin')
    } catch {
      setMessage('无法连接服务器，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return <main className="loginPage">
    <Card className="loginCard">
      <div className="brand"><span className="brandMark">AI</span>TEAM PLATFORM</div>
      <Typography.Title level={3} style={{ textAlign: 'center', marginTop: 20 }}>管理员登录</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>仅限团队管理员访问管理后台</Typography.Paragraph>
      <Form layout="vertical" size="large" onFinish={values => void submit(values as Record<string, string>)}>
        <Form.Item label="账号" name="userId" rules={[{ required: true, message: '请输入账号' }]}><Input autoFocus autoComplete="username" placeholder="账号或邮箱" /></Form.Item>
        <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password autoComplete="current-password" placeholder="密码" /></Form.Item>
        {message && <Typography.Paragraph className="message" type="danger">{message}</Typography.Paragraph>}
        <Button type="primary" htmlType="submit" loading={submitting} block>登录管理后台</Button>
      </Form>
    </Card>
  </main>
}

createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{ token: { colorPrimary: '#1677ff', borderRadius: 8 } }}><AntApp><LoginApp /></AntApp></ConfigProvider>)
