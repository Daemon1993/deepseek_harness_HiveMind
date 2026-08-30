import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp, Button, Card, ConfigProvider, Form, Input, Space, Typography } from 'antd'

type Mode = 'login' | 'apply'

function LoginApp() {
  const [mode, setMode] = useState<Mode>('login')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    void fetch('/team/session').then(async response => {
      const data = await response.json() as { authenticated?: boolean }
      if (response.ok && data.authenticated) window.location.replace('/team/enter')
    }).catch(() => undefined)
  }, [])

  /** POST 表单到本地转发路由并解析响应；网络失败统一提示。 */
  async function postForm(path: string, values: Record<string, string>): Promise<{ ok: boolean; message: string | undefined }> {
    setSubmitting(true)
    setMessage('')
    setSuccess(false)
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      })
      const data = await response.json() as { message?: string }
      if (!response.ok) setMessage(data.message ?? '请求失败')
      return { ok: response.ok, message: data.message }
    } catch {
      setMessage('无法连接团队服务器，请稍后重试')
      return { ok: false, message: undefined }
    } finally {
      setSubmitting(false)
    }
  }

  async function submitLogin(values: Record<string, string>): Promise<void> {
    const result = await postForm('/team/login', values)
    if (result.ok) window.location.replace('/team/enter')
  }

  async function submitApply(values: Record<string, string>): Promise<void> {
    const result = await postForm('/team/apply', values)
    if (!result.ok) return
    setSuccess(true)
    setMessage(result.message ?? '申请已提交，请等待管理员审核')
  }

  return <main className="loginPage">
    <section className="hero">
      <div className="brand"><span className="brandMark">AI</span>DEEPSEEK HARNESS</div>
      <h1>公司内部 AI<br />工作台</h1>
      <p>统一使用智能 Agent，智能辅助工作，沉淀团队经验，提升协作效率。</p>
    </section>
    <section className="formSide">
      <Card className="loginCard">
        <Typography.Text className="eyebrow">DEEPSEEK HARNESS</Typography.Text>
        <Typography.Title level={2}>{mode === 'login' ? '登录工作台' : '申请使用'}</Typography.Title>
        <Typography.Paragraph type="secondary">{mode === 'login' ? '登录后进入 DeepSeek Harness 工作区' : '提交邮箱和真实姓名，管理员激活后即可登录'}</Typography.Paragraph>
        {mode === 'login'
          ? <Form layout="vertical" size="large" onFinish={values => void submitLogin(values as Record<string, string>)}>
            <Form.Item label="账号" name="userId" rules={[{ required: true, message: '请输入账号' }]}><Input autoFocus autoComplete="username" placeholder="账号或邮箱" /></Form.Item>
            <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password autoComplete="current-password" placeholder="密码" /></Form.Item>
            <Button type="primary" htmlType="submit" loading={submitting} block>登录并进入工作台</Button>
          </Form>
          : <Form layout="vertical" size="large" onFinish={values => void submitApply(values as Record<string, string>)}>
            <Form.Item label="邮箱" name="email" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}><Input autoFocus placeholder="name@company.com" /></Form.Item>
            <Form.Item label="真实姓名" name="name" rules={[{ required: true, message: '请输入真实姓名' }]}><Input placeholder="真实姓名" /></Form.Item>
            <Button type="primary" htmlType="submit" loading={submitting} block>提交申请</Button>
          </Form>}
        {message && <Typography.Paragraph className="message" type={success ? 'success' : 'danger'}>{message}</Typography.Paragraph>}
        <Space style={{ marginTop: 20 }}><Typography.Text type="secondary">{mode === 'login' ? '还没有账号？' : '已有账号？'}</Typography.Text><Button className="switchButton" type="link" onClick={() => { setMode(current => current === 'login' ? 'apply' : 'login'); setMessage(''); setSuccess(false) }}>{mode === 'login' ? '申请使用' : '返回登录'}</Button></Space>
      </Card>
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{ token: { colorPrimary: '#1677ff', borderRadius: 10 } }}><AntApp><LoginApp /></AntApp></ConfigProvider>)
