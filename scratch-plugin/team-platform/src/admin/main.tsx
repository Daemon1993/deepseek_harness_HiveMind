import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, App as AntApp, Avatar, Badge, Button, Card, Col, Collapse, ConfigProvider, Drawer, Empty, Input, Layout, Menu, Popconfirm, Progress, Row, Segmented, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'

type Role = 'admin' | 'developer' | 'reviewer' | 'user'
type Status = 'pending' | 'active' | 'rejected' | 'disabled'
type User = { id: string; email?: string; name: string; status: Status; role: Role; password?: string }
type SessionOwner = { sessionId: string; userId: string; userName: string; email?: string; createdAt: string; lastActiveAt: string; title?: string; cwd?: string; updatedAt?: number; blank?: boolean }
type AnalyticsUser = { userId: string; userName: string; email?: string; status: Status; role: Role; sessionCount: number; recentSessionCount: number; directoryCount: number; firstUsedAt?: string; lastUsedAt?: string }
type AnalyticsDirectory = { path: string; name: string; sessionCount: number; userCount: number; lastActiveAt: string }
type Analytics = { rangeDays: number; generatedAt: string; summary: { totalUsers: number; activeAccounts: number; totalSessions: number; recentSessions: number; activeUsers: number; directoryCount: number }; users: AnalyticsUser[]; directories: AnalyticsDirectory[]; recentSessions: SessionOwner[] }
type InsightTool = { name: string; calls: number; failures: number; userCount: number; projectCount: number }
type InsightModel = { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }
type InsightUser = { userId: string; userName: string; toolCalls: number; toolFailures: number; modelRequests: number; totalTokens: number }
type InsightTrend = { date: string; activeUsers: number; newSessions: number; toolCalls: number; modelRequests: number }
type Insights = { rangeDays: number; generatedAt: string; summary: { toolCalls: number; toolFailures: number; modelRequests: number; inputTokens: number; outputTokens: number; totalTokens: number }; tools: InsightTool[]; models: InsightModel[]; users: InsightUser[]; trends: InsightTrend[] }
type TimelineItem = { time: number; kind: 'user' | 'assistant' | 'tool' | 'result' | 'model'; label: string; status?: 'success' | 'failed' }
type Phase = 'checking' | 'ready'
type Section = 'analytics' | 'insights' | 'accounts' | 'sessions'

const statusOptions = [{ value: 'pending', label: '待审核' }, { value: 'active', label: '已激活' }, { value: 'rejected', label: '已拒绝' }, { value: 'disabled', label: '已禁用' }] satisfies { value: Status; label: string }[]
const roleOptions = [{ value: 'admin', label: '管理员' }, { value: 'developer', label: '开发者' }, { value: 'reviewer', label: '审核员' }, { value: 'user', label: '普通用户' }] satisfies { value: Role; label: string }[]
const statusColors: Record<Status, string> = { pending: 'gold', active: 'green', rejected: 'red', disabled: 'default' }

function AdminRoot() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [section, setSection] = useState<Section>('accounts')
  const [currentUser, setCurrentUser] = useState<User>()
  const [users, setUsers] = useState<User[]>([])
  const [sessions, setSessions] = useState<SessionOwner[]>([])
  const [drafts, setDrafts] = useState<Record<string, User>>({})
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [toast, contextHolder] = message.useMessage()
  const canEdit = currentUser?.role === 'admin'

  const loadUsers = async (): Promise<void> => {
    setLoading(true)
    try {
      const response = await fetch('/team/admin/users')
      const data = await response.json() as { users?: User[]; message?: string }
      if (response.status === 401) { window.location.replace('/team/login-page'); return }
      if (!response.ok || data.users === undefined) { void toast.error(data.message ?? '加载失败'); return }
      setUsers(data.users); setDrafts(Object.fromEntries(data.users.map(user => [user.id, user]))); setPasswords(Object.fromEntries(data.users.map(user => [user.id, user.password ?? '']))); setPhase('ready')
    } finally { setLoading(false) }
  }
  const loadSessions = async (): Promise<void> => {
    if (!canEdit) return
    setLoading(true)
    try {
      const response = await fetch('/team/admin/sessions')
      const data = await response.json() as { sessions?: SessionOwner[]; message?: string }
      if (!response.ok || data.sessions === undefined) { void toast.error(data.message ?? '加载会话归属失败'); return }
      setSessions(data.sessions)
    } finally { setLoading(false) }
  }
  const checkSession = async (): Promise<void> => {
    try {
      const response = await fetch('/team/session')
      const data = await response.json() as { authenticated: boolean; user?: User }
      if (!data.authenticated || data.user === undefined) { window.location.replace('/team/login-page'); return }
      setCurrentUser(data.user); await loadUsers()
    } catch { window.location.replace('/team/login-page') }
  }
  useEffect(() => { void checkSession() }, [])
  useEffect(() => { if ((section === 'sessions' || section === 'insights') && canEdit) void loadSessions() }, [section, canEdit])

  const logout = async (): Promise<void> => { await fetch('/team/logout', { method: 'POST' }); window.location.replace('/team/login-page') }
  const save = async (id: string, patch: Partial<User> = {}): Promise<void> => {
    if (!canEdit) return
    const current = drafts[id]; if (current === undefined) return
    const draft = { ...current, ...patch }
    const response = await fetch(`/team/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: draft.name, status: draft.status, role: draft.role, password: passwords[id] ?? '' }) })
    const data = await response.json() as { message?: string }
    if (!response.ok) { void toast.error(data.message ?? '保存失败'); return }
    void toast.success(patch.status === 'active' ? '账号已激活' : '保存成功'); await loadUsers()
  }
  const remove = async (id: string): Promise<void> => {
    if (!canEdit) return
    const response = await fetch(`/team/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) { void toast.error(((await response.json()) as { message?: string }).message ?? '删除失败'); return }
    void toast.success('账号已删除'); await loadUsers()
  }
  const update = (id: string, patch: Partial<User>): void => setDrafts(current => ({ ...current, [id]: { ...current[id]!, ...patch } }))
  const columns = useMemo<ColumnsType<User>>(() => [
    { title: '账号', dataIndex: 'id', render: (id: string, user) => <Space><Avatar shape="square">{user.name.slice(0, 1)}</Avatar><Typography.Text strong>{id}</Typography.Text></Space> },
    { title: '邮箱', dataIndex: 'email', render: value => <Typography.Text type="secondary">{value ?? '—'}</Typography.Text> },
    { title: '姓名', render: (_, user) => <Input value={drafts[user.id]?.name ?? user.name} disabled={!canEdit} onChange={event => update(user.id, { name: event.target.value })} /> },
    { title: '密码', width: 180, render: (_, user) => canEdit ? <Input.Password value={passwords[user.id] ?? user.password ?? ''} placeholder="未设置密码" onChange={event => setPasswords(current => ({ ...current, [user.id]: event.target.value }))} /> : <Typography.Text type="secondary">******</Typography.Text> },
    { title: '状态', width: 145, render: (_, user) => <Select className="fieldSelect" value={drafts[user.id]?.status ?? user.status} options={statusOptions} disabled={!canEdit} onChange={(status: Status) => void save(user.id, { status })} optionRender={option => <Tag color={statusColors[option.value as Status]}>{option.label}</Tag>} /> },
    { title: '角色', width: 145, render: (_, user) => <Select className="fieldSelect" value={drafts[user.id]?.role ?? user.role} options={roleOptions} disabled={!canEdit} onChange={(role: Role) => update(user.id, { role })} /> },
    { title: '操作', width: 165, render: (_, user) => canEdit ? <Space><Button type="primary" onClick={() => void save(user.id)}>保存</Button><Popconfirm title="删除账号" description={`确定删除 ${user.id}？`} disabled={user.id === 'hahame'} onConfirm={() => void remove(user.id)}><Button danger disabled={user.id === 'hahame'}>删除</Button></Popconfirm></Space> : <Typography.Text type="secondary">仅查看</Typography.Text> },
  ], [canEdit, drafts, passwords])

  if (phase === 'checking') return <Centered><Card loading title="团队平台管理后台" /></Centered>
  const sectionCopy = section === 'analytics'
    ? { title: '使用分析', description: '查看团队成员的 Agent 使用情况和工作目录分布' }
    : section === 'insights'
      ? { title: '使用洞察', description: '工具、模型 Token、使用趋势与安全过程时间线' }
    : section === 'accounts'
      ? { title: '账号与权限', description: '统一管理账号申请、用户状态和角色权限' }
      : { title: '会话归属', description: '查看每位用户关联的全部 DSH Session' }
  return <Layout className="page">{contextHolder}<Layout.Sider width={240} theme="light" className="adminSider"><div className="brand"><div className="brandMark">AI</div><div><Typography.Text strong>TEAM PLATFORM</Typography.Text><Typography.Text type="secondary" className="blockText">管理控制台</Typography.Text></div></div><Menu mode="inline" selectedKeys={[section]} onSelect={({ key }) => { setSection(key as Section); document.getElementById('admin-main-scroll')?.scrollTo({ top: 0 }) }} items={[...(canEdit ? [{ key: 'analytics', label: '使用分析' }, { key: 'insights', label: '使用洞察' }] : []), { key: 'accounts', label: '账号与权限' }, ...(canEdit ? [{ key: 'sessions', label: <Space>会话归属<Badge count={sessions.length} showZero color="#1677ff" /></Space> }] : [])]} /><div className="siderUser"><Avatar>{currentUser?.name.slice(0, 1)}</Avatar><div><Typography.Text strong>{currentUser?.name}</Typography.Text><Typography.Text type="secondary" className="blockText">{roleOptions.find(item => item.value === currentUser?.role)?.label}</Typography.Text></div></div></Layout.Sider><Layout id="admin-main-scroll" className="mainLayout"><Layout.Header className="topbar"><div><Typography.Title level={3}>{sectionCopy.title}</Typography.Title><Typography.Text type="secondary">{sectionCopy.description}</Typography.Text></div><Button onClick={() => void logout()}>退出登录</Button></Layout.Header><Layout.Content className="content">{section === 'analytics' ? <AnalyticsPanel /> : section === 'insights' ? <InsightsPanel sessions={sessions} /> : section === 'accounts' ? <AccountsPanel users={users} loading={loading} columns={columns} /> : <SessionOwnershipPanel sessions={sessions} loading={loading} />}</Layout.Content></Layout></Layout>
}

function AnalyticsPanel() {
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const [data, setData] = useState<Analytics>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    void fetch(`/team/admin/analytics?days=${days}`).then(async response => {
      const body = await response.json() as Analytics & { message?: string }
      if (!response.ok) throw new Error(body.message ?? '加载使用分析失败')
      if (live) setData(body)
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '加载使用分析失败') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [days])
  const maxRecentSessions = Math.max(1, ...(data?.users.map(user => user.recentSessionCount) ?? [1]))
  const userColumns: ColumnsType<AnalyticsUser> = [
    { title: '成员', render: (_, user) => <Space><Avatar shape="square">{user.userName.slice(0, 1)}</Avatar><div><Typography.Text strong>{user.userName}</Typography.Text><Typography.Text type="secondary" className="blockText">{user.email ?? user.userId}</Typography.Text></div></Space> },
    { title: `近 ${days} 天会话`, dataIndex: 'recentSessionCount', width: 260, render: (value: number) => <Space size="middle" className="usageCell"><Progress percent={Math.round(value / maxRecentSessions * 100)} showInfo={false} size="small" /><Typography.Text strong>{value}</Typography.Text></Space> },
    { title: '全部会话', dataIndex: 'sessionCount', width: 110 },
    { title: '工作目录', dataIndex: 'directoryCount', width: 110 },
    { title: '首次使用', dataIndex: 'firstUsedAt', width: 180, render: value => value === undefined ? '—' : new Date(value).toLocaleString() },
    { title: '最近使用', dataIndex: 'lastUsedAt', width: 180, render: value => value === undefined ? <Tag>尚未使用</Tag> : new Date(value).toLocaleString() },
  ]
  const directoryColumns: ColumnsType<AnalyticsDirectory> = [
    { title: '工作目录', render: (_, directory) => <div><Typography.Text strong>{directory.name}</Typography.Text><Typography.Text code copyable={{ text: directory.path }} type="secondary" className="blockText analyticsPath">{directory.path}</Typography.Text></div> },
    { title: '会话数', dataIndex: 'sessionCount', width: 100 },
    { title: '使用人数', dataIndex: 'userCount', width: 100 },
    { title: '最近使用', dataIndex: 'lastActiveAt', width: 180, render: value => new Date(value).toLocaleString() },
  ]
  const recentColumns: ColumnsType<SessionOwner> = [
    { title: '会话', width: 320, render: (_, session) => <div className="recentSessionTitle"><Typography.Text strong ellipsis={{ tooltip: session.title ?? '新会话' }}>{session.title ?? '新会话'}</Typography.Text><Typography.Text code copyable={{ text: session.sessionId }} type="secondary" ellipsis>{session.sessionId}</Typography.Text></div> },
    { title: '成员', width: 150, render: (_, session) => session.userName },
    { title: '工作目录', dataIndex: 'cwd', render: value => value === undefined ? '未分组' : <Typography.Text code ellipsis={{ tooltip: value }}>{value}</Typography.Text> },
    { title: '最近使用', dataIndex: 'lastActiveAt', width: 180, render: value => new Date(value).toLocaleString() },
  ]
  return <Space direction="vertical" size={18} className="analyticsPage">
    <div className="analyticsToolbar"><Typography.Text type="secondary">统计范围内的活跃度按会话最近更新时间计算</Typography.Text><Segmented value={days} onChange={value => setDays(value as 1 | 7 | 30)} options={[{ label: '近 24 小时', value: 1 }, { label: '近 7 天', value: 7 }, { label: '近 30 天', value: 30 }]} /></div>
    {error && <Alert type="error" showIcon message={error} />}
    <Row gutter={[16, 16]} className="analyticsStats"><Col xs={24} sm={12} xl={6}><Card loading={loading}><Statistic title="团队成员" value={data?.summary.totalUsers ?? 0} /><Typography.Text type="secondary">{data?.summary.activeAccounts ?? 0} 个账号已激活</Typography.Text></Card></Col><Col xs={24} sm={12} xl={6}><Card loading={loading}><Statistic title={`近 ${days} 天活跃成员`} value={data?.summary.activeUsers ?? 0} valueStyle={{ color: '#1677ff' }} /><Typography.Text type="secondary">有会话更新的成员</Typography.Text></Card></Col><Col xs={24} sm={12} xl={6}><Card loading={loading}><Statistic title="全部会话" value={data?.summary.totalSessions ?? 0} /><Typography.Text type="secondary">近 {days} 天更新 {data?.summary.recentSessions ?? 0} 个</Typography.Text></Card></Col><Col xs={24} sm={12} xl={6}><Card loading={loading}><Statistic title="工作目录" value={data?.summary.directoryCount ?? 0} /><Typography.Text type="secondary">已关联的工作空间</Typography.Text></Card></Col></Row>
    <Card title="成员使用情况" className="analyticsCard"><Table rowKey="userId" loading={loading} columns={userColumns} dataSource={data?.users ?? []} pagination={false} scroll={{ x: 1050 }} /></Card>
    <Card title="工作目录分布" className="analyticsCard"><Table rowKey="path" loading={loading} size="middle" columns={directoryColumns} dataSource={data?.directories ?? []} pagination={{ pageSize: 6, showSizeChanger: false }} scroll={{ x: 760 }} /></Card>
    <Card title="最近使用的会话" className="analyticsCard"><Table rowKey="sessionId" loading={loading} size="middle" columns={recentColumns} dataSource={data?.recentSessions ?? []} pagination={{ pageSize: 6, showSizeChanger: false }} scroll={{ x: 980 }} /></Card>
  </Space>
}

function InsightsPanel({ sessions }: { sessions: SessionOwner[] }) {
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const [data, setData] = useState<Insights>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedSession, setSelectedSession] = useState<SessionOwner>()
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    void fetch(`/team/admin/insights?days=${days}`).then(async response => {
      const body = await response.json() as Insights & { message?: string }
      if (!response.ok) throw new Error(body.message ?? '加载使用洞察失败')
      if (live) setData(body)
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '加载使用洞察失败') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [days])
  const openTimeline = async (session: SessionOwner): Promise<void> => {
    setSelectedSession(session); setTimeline([]); setTimelineLoading(true)
    try {
      const response = await fetch(`/team/admin/insights/sessions/${encodeURIComponent(session.sessionId)}`)
      const body = await response.json() as { timeline?: TimelineItem[]; message?: string }
      if (!response.ok || body.timeline === undefined) throw new Error(body.message ?? '加载过程失败')
      setTimeline(body.timeline)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '加载过程失败') } finally { setTimelineLoading(false) }
  }
  const toolColumns: ColumnsType<InsightTool> = [
    { title: '工具', dataIndex: 'name' }, { title: '调用次数', dataIndex: 'calls', width: 110 },
    { title: '成功', width: 100, render: (_, item) => <Tag color="green">{item.calls - item.failures}</Tag> },
    { title: '失败', dataIndex: 'failures', width: 100, render: value => value === 0 ? '—' : <Tag color="red">{value}</Tag> },
    { title: '使用成员', dataIndex: 'userCount', width: 110 }, { title: '涉及目录', dataIndex: 'projectCount', width: 110 },
  ]
  const modelColumns: ColumnsType<InsightModel> = [
    { title: '模型', dataIndex: 'model', ellipsis: true }, { title: '请求', dataIndex: 'requests', width: 90 },
    { title: '输入 Token', dataIndex: 'inputTokens', width: 130 }, { title: '输出 Token', dataIndex: 'outputTokens', width: 130 },
    { title: '总 Token', dataIndex: 'totalTokens', width: 130 },
  ]
  const trendColumns: ColumnsType<InsightTrend> = [
    { title: '日期', dataIndex: 'date' }, { title: '活跃成员', dataIndex: 'activeUsers', width: 110 }, { title: '新会话', dataIndex: 'newSessions', width: 100 }, { title: '工具调用', dataIndex: 'toolCalls', width: 110 }, { title: '模型请求', dataIndex: 'modelRequests', width: 110 },
  ]
  const userColumns: ColumnsType<InsightUser> = [
    { title: '成员', render: (_, user) => <Space><Avatar shape="square">{user.userName.slice(0, 1)}</Avatar><Typography.Text strong>{user.userName}</Typography.Text></Space> },
    { title: '工具调用', dataIndex: 'toolCalls', width: 110 }, { title: '失败', dataIndex: 'toolFailures', width: 90 }, { title: '模型请求', dataIndex: 'modelRequests', width: 110 }, { title: '总 Token', dataIndex: 'totalTokens', width: 130 },
  ]
  const timelineItems = timeline.map(item => ({ color: item.status === 'failed' ? 'red' : item.kind === 'user' ? 'blue' : item.kind === 'tool' ? 'orange' : 'green', children: <Space direction="vertical" size={0}><Typography.Text strong>{item.label}</Typography.Text><Typography.Text type="secondary">{new Date(item.time).toLocaleString()}</Typography.Text></Space> }))
  return <Space direction="vertical" size={18} className="analyticsPage">
    <div className="analyticsToolbar"><Typography.Text type="secondary">仅聚合事件元数据，不展示原始对话、命令参数、文件内容或工具输出</Typography.Text><Segmented value={days} onChange={value => setDays(value as 1 | 7 | 30)} options={[{ label: '近 24 小时', value: 1 }, { label: '近 7 天', value: 7 }, { label: '近 30 天', value: 30 }]} /></div>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    <Row gutter={[16, 16]} className="analyticsStats"><Col xs={24} md={8}><Card loading={loading}><Statistic title="工具调用" value={data?.summary.toolCalls ?? 0} /><Typography.Text type="secondary">失败 {data?.summary.toolFailures ?? 0} 次</Typography.Text></Card></Col><Col xs={24} md={8}><Card loading={loading}><Statistic title="模型请求" value={data?.summary.modelRequests ?? 0} /><Typography.Text type="secondary">已完成的 Agent 回复</Typography.Text></Card></Col><Col xs={24} md={8}><Card loading={loading}><Statistic title="总 Token" value={data?.summary.totalTokens ?? 0} /><Typography.Text type="secondary">输入 {data?.summary.inputTokens ?? 0} · 输出 {data?.summary.outputTokens ?? 0}</Typography.Text></Card></Col></Row>
    <Card title="工具使用统计" className="analyticsCard"><Table rowKey="name" loading={loading} columns={toolColumns} dataSource={data?.tools ?? []} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 720 }} /></Card>
    <Card title="模型与成本" className="analyticsCard"><Table rowKey="model" loading={loading} columns={modelColumns} dataSource={data?.models ?? []} pagination={false} scroll={{ x: 780 }} /></Card>
    <Card title="团队趋势" className="analyticsCard"><Table rowKey="date" loading={loading} columns={trendColumns} dataSource={data?.trends ?? []} pagination={false} scroll={{ x: 620 }} /></Card>
    <Card title="成员使用排行" className="analyticsCard"><Table rowKey="userId" loading={loading} columns={userColumns} dataSource={data?.users ?? []} pagination={false} scroll={{ x: 720 }} /></Card>
    <Card title="使用过程时间线" extra={<Typography.Text type="secondary">选择已归属会话查看</Typography.Text>} className="analyticsCard"><Table rowKey="sessionId" size="small" loading={loading} dataSource={sessions} pagination={{ pageSize: 8, showSizeChanger: false }} columns={[{ title: '会话', render: (_, session) => <div><Typography.Text strong>{session.title ?? '新会话'}</Typography.Text><Typography.Text type="secondary" code className="blockText">{session.sessionId}</Typography.Text></div> }, { title: '成员', dataIndex: 'userName', width: 160 }, { title: '更新时间', dataIndex: 'lastActiveAt', width: 190, render: value => new Date(value).toLocaleString() }, { title: '操作', width: 120, render: (_, session) => <Button type="link" onClick={() => void openTimeline(session)}>查看过程</Button> }]} scroll={{ x: 700 }} /></Card>
    <Drawer title={selectedSession?.title ?? '会话过程'} open={selectedSession !== undefined} onClose={() => setSelectedSession(undefined)} width={460}><Typography.Paragraph type="secondary">时间线仅显示事件类型、工具名称、成功状态及时间，不包含会话内容、工具参数或执行结果。</Typography.Paragraph>{timelineLoading ? <Card loading /> : timeline.length === 0 ? <Empty description="没有可展示的事件" /> : <Timeline items={timelineItems} />}</Drawer>
  </Space>
}

function AccountsPanel({ users, loading, columns }: { users: User[]; loading: boolean; columns: ColumnsType<User> }) {
  return <><Row gutter={16} className="stats"><Col span={8}><Card><Statistic title="全部账号" value={users.length} /></Card></Col><Col span={8}><Card><Statistic title="待审核申请" value={users.filter(user => user.status === 'pending').length} valueStyle={{ color: '#d48806' }} /></Card></Col><Col span={8}><Card><Statistic title="已激活账号" value={users.filter(user => user.status === 'active').length} valueStyle={{ color: '#389e0d' }} /></Card></Col></Row><Card className="tableCard"><Table rowKey="id" columns={columns} dataSource={users} loading={loading} scroll={{ x: 1100 }} pagination={{ pageSize: 10, showSizeChanger: false }} rowClassName={user => user.status === 'pending' ? 'pendingRow' : ''} /></Card></>
}

function SessionOwnershipPanel({ sessions, loading }: { sessions: SessionOwner[]; loading: boolean }) {
  const groups = Object.values(sessions.reduce<Record<string, { userId: string; userName: string; email?: string; sessions: SessionOwner[] }>>((all, session) => { const group = all[session.userId] ?? { userId: session.userId, userName: session.userName, ...(session.email ? { email: session.email } : {}), sessions: [] }; group.sessions.push(session); all[session.userId] = group; return all }, {}))
  const columns: ColumnsType<SessionOwner> = [{ title: '会话', dataIndex: 'title', render: (_, session) => <div><Typography.Text strong>{session.title ?? '会话记录不可用'}</Typography.Text><div><Typography.Text code copyable type="secondary">{session.sessionId}</Typography.Text></div></div> }, { title: '更新时间', dataIndex: 'updatedAt', width: 190, render: (_, session) => session.updatedAt === undefined ? '—' : new Date(session.updatedAt).toLocaleString() }, { title: '创建时间', dataIndex: 'createdAt', width: 190, render: value => new Date(value).toLocaleString() }]
  return <><Row gutter={16} className="stats"><Col span={8}><Card><Statistic title="已关联用户" value={groups.length} /></Card></Col><Col span={8}><Card><Statistic title="全部 Session" value={sessions.length} /></Card></Col><Col span={8}><Card><Statistic title="平均每人" value={groups.length ? (sessions.length / groups.length).toFixed(1) : 0} /></Card></Col></Row><Card className="sessionCard" loading={loading}>{groups.length === 0 ? <Empty description="暂无会话归属记录" /> : <Collapse defaultActiveKey={groups.map(group => group.userId)} items={groups.map(group => { const directories = Object.values(group.sessions.reduce<Record<string, { cwd?: string; sessions: SessionOwner[] }>>((all, session) => { const key = session.cwd ?? '__ungrouped__'; const directory = all[key] ?? { ...(session.cwd === undefined ? {} : { cwd: session.cwd }), sessions: [] }; directory.sessions.push(session); all[key] = directory; return all }, {})); return { key: group.userId, label: <div className="userGroupLabel"><Space><Avatar shape="square">{group.userName.slice(0, 1)}</Avatar><div><Typography.Text strong>{group.userName}</Typography.Text><Typography.Text type="secondary" className="blockText">{group.email ?? group.userId}</Typography.Text></div></Space><Tag color="blue">{group.sessions.length} 个 Session</Tag></div>, children: <Collapse className="directoryGroups" defaultActiveKey={directories.map(directory => directory.cwd ?? '__ungrouped__')} items={directories.map(directory => ({ key: directory.cwd ?? '__ungrouped__', label: <div className="directoryLabel"><div><Typography.Text strong>{directory.cwd === undefined ? '未分组' : directory.cwd.split(/[\\/]/).filter(Boolean).at(-1)}</Typography.Text>{directory.cwd !== undefined && <Typography.Text code copyable={{ text: directory.cwd }} type="secondary" className="directoryPath">{directory.cwd}</Typography.Text>}</div><Tag>{directory.sessions.length} 个会话</Tag></div>, children: <Table rowKey="sessionId" size="middle" columns={columns} dataSource={directory.sessions} pagination={false} /> }))} /> } })} />}</Card></>
}

function Centered({ children }: { children: ReactNode }) { return <div className="centered">{children}</div> }
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{ token: { colorPrimary: '#1677ff', borderRadius: 10 }, components: { Layout: { siderBg: '#fff', headerBg: '#fff' }, Menu: { itemBorderRadius: 8 } } }}><AntApp><AdminRoot /></AntApp></ConfigProvider>)
