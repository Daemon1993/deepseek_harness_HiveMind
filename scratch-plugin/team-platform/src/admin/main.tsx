import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  App as AntApp, Button, Card, Col, ConfigProvider, Form, Input, Layout,
  Popconfirm, Result, Row, Select, Space, Statistic, Table, Tag, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'

type Role = 'admin' | 'developer' | 'reviewer' | 'user'
type Status = 'pending' | 'active' | 'rejected' | 'disabled'
type User = { id: string; email?: string; name: string; status: Status; role: Role; password: string }
type Phase = 'checking' | 'login' | 'forbidden' | 'ready'

const statusOptions = [
  { value: 'pending', label: '待审核' }, { value: 'active', label: '已激活' },
  { value: 'rejected', label: '已拒绝' }, { value: 'disabled', label: '已禁用' },
] satisfies { value: Status; label: string }[]
const roleOptions = [
  { value: 'admin', label: '管理员' }, { value: 'developer', label: '开发者' },
  { value: 'reviewer', label: '审核员' }, { value: 'user', label: '普通用户' },
] satisfies { value: Role; label: string }[]
const statusColors: Record<Status, string> = { pending: 'gold', active: 'green', rejected: 'red', disabled: 'default' }

function AdminRoot() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [users, setUsers] = useState<User[]>([])
  const [drafts, setDrafts] = useState<Record<string, User>>({})
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [toast, contextHolder] = message.useMessage()

  const loadUsers = async (): Promise<void> => {
    setLoading(true)
    try {
      const response = await fetch('/team/admin/users')
      const data = await response.json() as { users?: User[]; message?: string }
      if (response.status === 403) { setPhase('forbidden'); setNotice(data.message ?? '需要管理员权限'); return }
      if (!response.ok || data.users === undefined) { void toast.error(data.message ?? '加载失败'); return }
      setUsers(data.users); setDrafts(Object.fromEntries(data.users.map(user => [user.id, user]))); setPasswords(Object.fromEntries(data.users.map(user => [user.id, user.password]))); setPhase('ready')
    } finally { setLoading(false) }
  }
  const checkSession = async (): Promise<void> => {
    try {
      const response = await fetch('/team/session')
      const data = await response.json() as { authenticated: boolean; user?: User }
      if (!data.authenticated || data.user === undefined) { setPhase('login'); return }
      if (data.user.role !== 'admin') { setNotice(`账号 ${data.user.id} 没有管理员权限`); setPhase('forbidden'); return }
      await loadUsers()
    } catch { setNotice('无法连接服务器'); setPhase('login') }
  }
  useEffect(() => { void checkSession() }, [])

  const logout = async (): Promise<void> => { await fetch('/team/logout', { method: 'POST' }); setUsers([]); setNotice(''); setPhase('login') }
  const save = async (id: string, patch: Partial<User> = {}): Promise<void> => {
    const current = drafts[id]; if (current === undefined) return
    const draft = { ...current, ...patch }
    const response = await fetch(`/team/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: draft.name, status: draft.status, role: draft.role, password: passwords[id] ?? '' }) })
    const data = await response.json() as { message?: string }
    if (!response.ok) { void toast.error(data.message ?? '保存失败'); return }
    void toast.success(patch.status === 'active' ? '账号已激活' : '保存成功'); await loadUsers()
  }
  const remove = async (id: string): Promise<void> => {
    const response = await fetch(`/team/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) { void toast.error(((await response.json()) as { message?: string }).message ?? '删除失败'); return }
    void toast.success('账号已删除'); await loadUsers()
  }
  const update = (id: string, patch: Partial<User>): void => setDrafts(current => ({ ...current, [id]: { ...current[id]!, ...patch } }))

  const columns = useMemo<ColumnsType<User>>(() => [
    { title: '账号', dataIndex: 'id', render: (id: string, user) => <Space><span className="avatar">{user.name.slice(0, 1)}</span><Typography.Text strong>{id}</Typography.Text></Space> },
    { title: '邮箱', dataIndex: 'email', render: value => <Typography.Text type="secondary">{value ?? '—'}</Typography.Text> },
    { title: '姓名', render: (_, user) => <Input value={drafts[user.id]?.name ?? user.name} onChange={event => update(user.id, { name: event.target.value })} /> },
    { title: '密码', width: 180, render: (_, user) => <Input.Password value={passwords[user.id] ?? user.password} placeholder="未设置密码" autoComplete="new-password" onChange={event => setPasswords(current => ({ ...current, [user.id]: event.target.value }))} /> },
    { title: '状态', width: 150, render: (_, user) => <Select className="fieldSelect" value={drafts[user.id]?.status ?? user.status} options={statusOptions} onChange={(status: Status) => void save(user.id, { status })} optionRender={option => <Tag color={statusColors[option.value as Status]}>{option.label}</Tag>} /> },
    { title: '角色', width: 150, render: (_, user) => <Select className="fieldSelect" value={drafts[user.id]?.role ?? user.role} options={roleOptions} onChange={(role: Role) => update(user.id, { role })} /> },
    { title: '操作', width: 170, render: (_, user) => <Space><Button type="primary" onClick={() => void save(user.id)}>保存</Button><Popconfirm title="删除账号" description={`确定删除 ${user.id}？`} disabled={user.id === 'hahame'} onConfirm={() => void remove(user.id)}><Button danger disabled={user.id === 'hahame'}>删除</Button></Popconfirm></Space> },
  ], [drafts, passwords])

  if (phase === 'checking') return <Centered><Card loading title="团队平台管理后台" /></Centered>
  if (phase === 'login') return <AdminLogin initialMessage={notice} onSuccess={loadUsers} />
  if (phase === 'forbidden') return <Centered><Result status="403" title="无权访问" subTitle={notice} extra={<Button type="primary" onClick={() => void logout()}>退出并使用管理员登录</Button>} /></Centered>
  return <Layout className="page"><Layout.Content className="content">{contextHolder}<div className="header"><div><Typography.Text className="eyebrow">TEAM PLATFORM</Typography.Text><Typography.Title level={2}>团队平台管理后台</Typography.Title><Typography.Text type="secondary">统一管理账号申请、用户状态和角色权限</Typography.Text></div><Button onClick={() => void logout()}>退出登录</Button></div><Row gutter={16} className="stats"><Col span={8}><Card><Statistic title="全部账号" value={users.length} /></Card></Col><Col span={8}><Card><Statistic title="待审核申请" value={users.filter(user => user.status === 'pending').length} valueStyle={{ color: '#d48806' }} /></Card></Col><Col span={8}><Card><Statistic title="已激活账号" value={users.filter(user => user.status === 'active').length} valueStyle={{ color: '#389e0d' }} /></Card></Col></Row><Card className="tableCard"><Table rowKey="id" columns={columns} dataSource={users} loading={loading} scroll={{ x: 1100 }} pagination={{ pageSize: 10, showSizeChanger: false }} rowClassName={user => user.status === 'pending' ? 'pendingRow' : ''} locale={{ emptyText: '暂无账号或申请' }} /></Card></Layout.Content></Layout>
}

function AdminLogin({ initialMessage, onSuccess }: { initialMessage: string; onSuccess: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState(initialMessage)
  const submit = async ({ userId, password }: { userId: string; password: string }): Promise<void> => {
    setSubmitting(true); setError('')
    try {
      const response = await fetch('/team/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, password }) })
      const data = await response.json() as { message?: string; user?: User }
      if (!response.ok) { setError(data.message ?? '登录失败'); return }
      if (data.user?.role !== 'admin') { setError('该账号不是管理员'); await fetch('/team/logout', { method: 'POST' }); return }
      await onSuccess()
    } catch { setError('登录请求失败') } finally { setSubmitting(false) }
  }
  return <Centered><Card className="loginCard"><Typography.Text className="eyebrow">TEAM PLATFORM</Typography.Text><Typography.Title level={2}>管理员登录</Typography.Title><Typography.Paragraph type="secondary">请使用管理员账号进入管理后台</Typography.Paragraph><Form layout="vertical" size="large" onFinish={values => void submit(values as { userId: string; password: string })}><Form.Item label="账号" name="userId" rules={[{ required: true, message: '请输入账号' }]}><Input autoFocus autoComplete="username" placeholder="管理员账号" /></Form.Item><Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password autoComplete="current-password" placeholder="管理员密码" /></Form.Item>{error && <Typography.Paragraph type="danger">{error}</Typography.Paragraph>}<Button type="primary" htmlType="submit" loading={submitting} block>登录</Button></Form></Card></Centered>
}

function Centered({ children }: { children: ReactNode }) { return <div className="centered">{children}</div> }
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{ token: { colorPrimary: '#1677ff', borderRadius: 10 } }}><AntApp><AdminRoot /></AntApp></ConfigProvider>)
