import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, App as AntApp, Avatar, Badge, Button, Card, Col, Collapse, ConfigProvider, Drawer, Empty, Input, Layout, Menu, Popconfirm, Row, Segmented, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'

type Role = 'admin' | 'developer' | 'reviewer' | 'user'
type Status = 'pending' | 'active' | 'rejected' | 'disabled'
type User = { id: string; email?: string; name: string; status: Status; role: Role; password?: string }
type SessionOwner = { sessionId: string; userId: string; userName: string; email?: string; createdAt: string; lastActiveAt: string; title?: string; cwd?: string; updatedAt?: number; blank?: boolean }
type Phase = 'checking' | 'ready'
type Section = 'dashboard' | 'sessions' | 'accounts' | 'sync'

// ── 总览类型（/team/admin/overview）──────────────────────────
type OverviewSummary = {
  sessions: number; activeUsers: number; projects: number
  userMessages: number; assistantMessages: number
  toolCalls: number; toolFailures: number; toolFailureRate: number
  modelRequests: number; inputTokens: number; outputTokens: number; totalTokens: number
  activeDurationMs: number; durationMs: number; errors: number
}
type OverviewTrend = { date: string; sessions: number; activeUsers: number; toolCalls: number; modelRequests: number; totalTokens: number }
type OverviewUser = { userId: string; userName: string; sessions: number; toolCalls: number; toolFailures: number; modelRequests: number; totalTokens: number; durationMs: number }
type OverviewDirectory = { path: string; name: string; sessions: number; users: number; toolCalls: number; modelRequests: number; totalTokens: number }
type OverviewTool = { name: string; calls: number; failures: number; users: number }
type OverviewModel = { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }
type OverviewRecent = { sessionId: string; title: string; userName: string; cwd?: string; lastActiveAt: number; toolCalls: number; durationMs: number; errorCount: number }
type Overview = {
  rangeDays: number; generatedAt: string; summary: OverviewSummary
  trends: OverviewTrend[]; users: OverviewUser[]; directories: OverviewDirectory[]
  tools: OverviewTool[]; models: OverviewModel[]; recentSessions: OverviewRecent[]
}

// ── 会话详情类型（/team/admin/insights/sessions/:id）─────────
type SessionMetrics = {
  userMessages: number; assistantMessages: number; toolCalls: number; toolFailures: number
  turnCount: number; stepCount: number; errorCount: number; durationMs: number
  firstTime: number; lastTime: number
  tools: { name: string; calls: number; failures: number; totalMs: number; avgMs: number; maxMs: number }[]
  models: { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }[]
  timeline: { time: number; kind: string; label: string; status?: string }[]
}
type SessionDetail = { session: SessionOwner; metrics: SessionMetrics; timeline: SessionMetrics['timeline'] }

type SyncSession = { sessionId: string; updatedAt: string }
type SyncUser = { userId: string; userName: string; sessions: SyncSession[]; lastSyncAt: string | null }
type SyncStatus = { generatedAt: string; summary: { totalUsers: number; totalSessions: number; lastSyncAt: string | null }; users: SyncUser[] }

const statusOptions = [{ value: 'pending', label: '待审核' }, { value: 'active', label: '已激活' }, { value: 'rejected', label: '已拒绝' }, { value: 'disabled', label: '已禁用' }] satisfies { value: Status; label: string }[]
const roleOptions = [{ value: 'admin', label: '管理员' }, { value: 'developer', label: '开发者' }, { value: 'reviewer', label: '审核员' }, { value: 'user', label: '普通用户' }] satisfies { value: Role; label: string }[]
const statusColors: Record<Status, string> = { pending: 'gold', active: 'green', rejected: 'red', disabled: 'default' }

const fmt = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60); const r = s % 60
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m${r}s`
}
const fmtNum = (n: number): string => n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n)
/** 按日柱状图（趋势）。 */
function TrendChart({ data }: { data: OverviewTrend[] }) {
  const max = Math.max(1, ...data.map(d => d.toolCalls))
  return <div className="chart-trend">
    {data.map(d => (
      <div key={d.date} className={d.toolCalls === 0 ? 'bar empty' : 'bar'} style={{ height: `${Math.max(3, Math.round(d.toolCalls / max * 100))}%` }}>
        <span className="v">{d.toolCalls}</span>
        <span className="d">{d.date.slice(5)}</span>
      </div>
    ))}
  </div>
}

/** 水平条形图（排行）。 */
function HBarChart({ rows, color }: { rows: { label: string; value: number; display?: string }[]; color?: 'blue' | 'green' | 'purple' }) {
  const max = Math.max(1, ...rows.map(r => r.value))
  const cls = color === 'green' ? 'fill green' : color === 'purple' ? 'fill purple' : 'fill'
  return <div className="chart-hbar">
    {rows.slice(0, 8).map(r => (
      <div key={r.label} className="row">
        <span className="lbl" title={r.label}>{r.label}</span>
        <div className="trk"><div className={cls} style={{ width: `${Math.max(2, Math.round(r.value / max * 100))}%` }}>{r.value > 0 ? '' : ''}</div></div>
        <span className="val">{r.display ?? r.value}</span>
      </div>
    ))}
  </div>
}

/** 圆环图（模型 Token 占比）。 */
function DonutChart({ models }: { models: OverviewModel[] }) {
  const total = Math.max(1, models.reduce((sum, m) => sum + m.totalTokens, 0))
  const palette = ['#1677ff', '#7c3aed', '#13c2c2', '#d97706', '#52c41a', '#f5222d', '#722ed1', '#fa8c16']
  let acc = 0
  const stops = models.map((m, i) => {
    const from = acc; acc += m.totalTokens / total * 100
    return `${palette[i % palette.length]} ${from}% ${acc}%`
  }).join(', ')
  return <div className="chart-donut">
    <div className="ring" style={{ background: `conic-gradient(${stops})` }}>
      <div className="hole"><div><div style={{ fontSize: 20, fontWeight: 800, color: '#334155' }}>{fmtNum(total)}</div><div style={{ fontSize: 11, color: '#94a3b8' }}>Tokens</div></div></div>
    </div>
    <div className="legend">
      {models.slice(0, 6).map((m, i) => (
        <div key={m.model} className="lg">
          <span className="dot" style={{ background: palette[i % palette.length] }} />
          <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.model}>{m.model}</span>
          <span className="pct">{Math.round(m.totalTokens / total * 100)}%</span>
        </div>
      ))}
    </div>
  </div>
}


function AdminRoot() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [section, setSection] = useState<Section>('dashboard')
  const [currentUser, setCurrentUser] = useState<User>()
  const [users, setUsers] = useState<User[]>([])
  const [sessions, setSessions] = useState<SessionOwner[]>([])
  const [detail, setDetail] = useState<SessionDetail>()
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
  useEffect(() => { if ((section === 'sessions') && canEdit) void loadSessions() }, [section, canEdit])

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
  const sectionCopy = section === 'dashboard'
    ? { title: '总览', description: '团队 AI 使用情况的统一视图：会话、成员、项目、工具、模型' }
    : section === 'accounts'
      ? { title: '账号与权限', description: '统一管理账号申请、用户状态和角色权限' }
    : section === 'sync'
      ? { title: '同步状态', description: '查看每位用户的 Session 同步进度与健康情况' }
      : { title: '会话', description: '按用户与项目查看全部会话，点击查看完整分析' }
  return <><Layout className="page">{contextHolder}<Layout.Sider width={240} theme="light" className="adminSider"><div className="brand"><div className="brandMark">AI</div><div><Typography.Text strong>TEAM PLATFORM</Typography.Text><Typography.Text type="secondary" className="blockText">管理控制台</Typography.Text></div></div><Menu mode="inline" selectedKeys={[section]} onSelect={({ key }) => { setSection(key as Section); document.getElementById('admin-main-scroll')?.scrollTo({ top: 0 }) }} items={[...(canEdit ? [{ key: 'dashboard', label: '总览' }] : []), { key: 'accounts', label: '账号与权限' }, ...(canEdit ? [{ key: 'sessions', label: <Space>会话<Badge count={sessions.length} showZero color="#1677ff" /></Space> }, { key: 'sync', label: '同步状态' }] : [])]} /><div className="siderUser"><Avatar>{currentUser?.name.slice(0, 1)}</Avatar><div><Typography.Text strong>{currentUser?.name}</Typography.Text><Typography.Text type="secondary" className="blockText">{roleOptions.find(item => item.value === currentUser?.role)?.label}</Typography.Text></div></div></Layout.Sider><Layout id="admin-main-scroll" className="mainLayout"><Layout.Header className="topbar"><div><Typography.Title level={3}>{sectionCopy.title}</Typography.Title><Typography.Text type="secondary">{sectionCopy.description}</Typography.Text></div><Space><Button onClick={() => void logout()}>退出登录</Button></Space></Layout.Header><Layout.Content className="content">{section === 'dashboard' ? <DashboardPanel onOpenSession={setDetail} /> : section === 'accounts' ? <AccountsPanel users={users} loading={loading} columns={columns} /> : section === 'sync' ? <SyncStatusPanel /> : <SessionOwnershipPanel sessions={sessions} loading={loading} onOpenSession={setDetail} />}</Layout.Content></Layout></Layout><SessionDetailDrawer detail={detail} onClose={() => setDetail(undefined)} /></>
}

/** 会话详情抽屉：完整指标 + 分组时间线 + 工具耗时。 */
function SessionDetailDrawer({ detail, onClose }: { detail: SessionDetail | undefined; onClose: () => void }) {
  if (detail === undefined) return null
  const m = detail.metrics
  const metricCards = [
    { title: '对话消息', value: `${m.userMessages} 进 / ${m.assistantMessages} 出` },
    { title: '轮次 / 步骤', value: `${m.turnCount} / ${m.stepCount}` },
    { title: '工具调用', value: `${m.toolCalls} 次${m.toolFailures > 0 ? `（失败 ${m.toolFailures}）` : ''}` },
    { title: '时长', value: fmt(m.durationMs) },
    { title: '错误', value: String(m.errorCount) },
  ]
  const toolColumns: ColumnsType<SessionMetrics['tools'][number]> = [
    { title: '工具', dataIndex: 'name' },
    { title: '调用', dataIndex: 'calls', width: 80 },
    { title: '失败', dataIndex: 'failures', width: 80, render: v => v === 0 ? <Tag color="green">0</Tag> : <Tag color="red">{v}</Tag> },
    { title: '平均耗时', width: 100, render: (_, t) => fmt(t.avgMs) },
    { title: '最慢', width: 100, render: (_, t) => fmt(t.maxMs) },
  ]
  const timelineItems = m.timeline.map(item => ({
    color: item.status === 'failed' || item.kind === 'error' ? 'red'
      : item.kind === 'user' ? 'blue'
      : item.kind === 'tool' ? 'orange'
      : item.kind === 'turn' ? 'purple'
      : 'green',
    children: <Space direction="vertical" size={0}><Typography.Text strong>{item.label}</Typography.Text><Typography.Text type="secondary">{new Date(item.time).toLocaleString()}</Typography.Text></Space>,
  }))
  return <Drawer title={detail.session.title ?? '会话详情'} open onClose={onClose} width={680}>
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Card size="small" title="会话信息">
        <Row gutter={[12, 8]}>
          <Col span={12}><Typography.Text type="secondary">成员：</Typography.Text>{detail.session.userName}（{detail.session.userId}）</Col>
          <Col span={12}><Typography.Text type="secondary">创建：</Typography.Text>{new Date(detail.session.createdAt).toLocaleString()}</Col>
          {detail.session.cwd !== undefined && <Col span={24}><Typography.Text type="secondary">目录：</Typography.Text><Typography.Text code copyable>{detail.session.cwd}</Typography.Text></Col>}
          <Col span={24}><Typography.Text type="secondary">会话 ID：</Typography.Text><Typography.Text code copyable>{detail.session.sessionId}</Typography.Text></Col>
        </Row>
      </Card>
      <Row gutter={[12, 12]}>
        {metricCards.map(card => <Col key={card.title} xs={12} sm={8}><Card size="small"><Statistic title={card.title} value={card.value} /></Card></Col>)}
      </Row>
      {m.models.length > 0 && <Card size="small" title="模型与 Token">
        <Space wrap>{m.models.map(model => <Tag color="blue" key={model.model}>{model.model} · {model.requests} 请求 · {fmtNum(model.totalTokens)} tokens</Tag>)}</Space>
      </Card>}
      {m.tools.length > 0 && <Card size="small" title="工具耗时"><Table rowKey="name" size="small" columns={toolColumns} dataSource={m.tools} pagination={false} /></Card>}
      <Card size="small" title="过程时间线（仅事件类型/工具/成功状态，不含内容）">
        {timelineItems.length === 0 ? <Empty description="没有可展示的事件" /> : <Timeline items={timelineItems} />}
      </Card>
    </Space>
  </Drawer>
}

/** 总览：统一指标卡 + 趋势 + 用户/项目/工具/模型排行 + 最近会话。 */
function DashboardPanel({ onOpenSession }: { onOpenSession: (d: SessionDetail) => void }) {
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const [data, setData] = useState<Overview>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    void fetch(`/team/admin/overview?days=${days}`).then(async response => {
      const body = await response.json() as Overview & { message?: string }
      if (!response.ok) throw new Error(body.message ?? '加载总览失败')
      if (live) setData(body)
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '加载总览失败') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [days])

  const s = data?.summary
  const statCards = [
    { title: '会话', value: s?.sessions ?? 0, sub: `${s?.activeUsers ?? 0} 位活跃用户` },
    { title: '项目', value: s?.projects ?? 0, sub: '活跃工作目录' },
    { title: '工具调用', value: s?.toolCalls ?? 0, sub: `失败率 ${s?.toolFailureRate ?? 0}%` },
    { title: '模型请求', value: s?.modelRequests ?? 0, sub: `${s?.assistantMessages ?? 0} 条回复` },
    { title: 'Token', value: s?.totalTokens ?? 0, sub: `进 ${fmtNum(s?.inputTokens ?? 0)} · 出 ${fmtNum(s?.outputTokens ?? 0)}` },
    { title: '活跃时长', value: fmt(s?.activeDurationMs ?? 0), sub: `跨度 ${fmt(s?.durationMs ?? 0)}` },
    { title: '消息', value: (s?.userMessages ?? 0) + (s?.assistantMessages ?? 0), sub: '用户 + 助手' },
    { title: '错误', value: s?.errors ?? 0, sub: s?.errors ? '需关注' : '无', danger: (s?.errors ?? 0) > 0 },
  ]
  const userColumns: ColumnsType<OverviewUser> = [
    { title: '成员', render: (_, u) => <Space><Avatar shape="square">{u.userName.slice(0, 1)}</Avatar><Typography.Text strong>{u.userName}</Typography.Text><Typography.Text type="secondary">{u.userId}</Typography.Text></Space> },
    { title: '会话', dataIndex: 'sessions', width: 70 },
    { title: '工具', dataIndex: 'toolCalls', width: 90 },
    { title: '失败', dataIndex: 'toolFailures', width: 70, render: v => v === 0 ? <Tag color="green">0</Tag> : <Tag color="red">{v}</Tag> },
    { title: '模型请求', dataIndex: 'modelRequests', width: 90 },
    { title: 'Token', dataIndex: 'totalTokens', width: 100, render: v => fmtNum(v) },
    { title: '时长', width: 90, render: (_, u) => fmt(u.durationMs) },
  ]
  const dirColumns: ColumnsType<OverviewDirectory> = [
    { title: '项目', render: (_, d) => <div><Typography.Text strong>{d.name}</Typography.Text><Typography.Text code copyable={{ text: d.path }} type="secondary" className="blockText">{d.path}</Typography.Text></div> },
    { title: '会话', dataIndex: 'sessions', width: 70 },
    { title: '用户', dataIndex: 'users', width: 70 },
    { title: '工具', dataIndex: 'toolCalls', width: 90 },
    { title: '模型请求', dataIndex: 'modelRequests', width: 90 },
    { title: 'Token', dataIndex: 'totalTokens', width: 100, render: v => fmtNum(v) },
  ]
  const toolColumns: ColumnsType<OverviewTool> = [
    { title: '工具', dataIndex: 'name' },
    { title: '调用', dataIndex: 'calls', width: 100 },
    { title: '成功', width: 90, render: (_, t) => <Tag color="green">{t.calls - t.failures}</Tag> },
    { title: '失败', dataIndex: 'failures', width: 90, render: v => v === 0 ? '—' : <Tag color="red">{v}</Tag> },
    { title: '使用成员', dataIndex: 'users', width: 90 },
  ]
  const modelColumns: ColumnsType<OverviewModel> = [
    { title: '模型', dataIndex: 'model', ellipsis: true },
    { title: '请求', dataIndex: 'requests', width: 80 },
    { title: '输入 Token', dataIndex: 'inputTokens', width: 110, render: v => fmtNum(v) },
    { title: '输出 Token', dataIndex: 'outputTokens', width: 110, render: v => fmtNum(v) },
    { title: '总 Token', dataIndex: 'totalTokens', width: 110, render: v => fmtNum(v) },
  ]
  const recentColumns: ColumnsType<OverviewRecent> = [
    { title: '会话', width: 300, render: (_, r) => <div><Typography.Text strong>{r.title}</Typography.Text><Typography.Text code copyable={{ text: r.sessionId }} type="secondary" className="blockText">{r.sessionId.slice(0, 20)}</Typography.Text></div> },
    { title: '成员', width: 140, render: (_, r) => r.userName },
    { title: '目录', dataIndex: 'cwd', ellipsis: true, render: v => v === undefined ? '未分组' : <Typography.Text code ellipsis={{ tooltip: v }}>{v}</Typography.Text> },
    { title: '工具', dataIndex: 'toolCalls', width: 80 },
    { title: '时长', width: 90, render: (_, r) => fmt(r.durationMs) },
    { title: '错误', dataIndex: 'errorCount', width: 70, render: v => v === 0 ? '—' : <Tag color="red">{v}</Tag> },
    { title: '操作', width: 90, render: (_, r) => <Button type="link" onClick={() => void openDetail(r.sessionId, onOpenSession)}>详情</Button> },
  ]
  return <Space direction="vertical" size={18} className="analyticsPage">
    <div className="analyticsToolbar"><Typography.Text type="secondary">统一视图：会话过程、成员活跃、项目产出、工具与模型消耗</Typography.Text><Segmented value={days} onChange={value => setDays(value as 1 | 7 | 30)} options={[{ label: '近 24 小时', value: 1 }, { label: '近 7 天', value: 7 }, { label: '近 30 天', value: 30 }]} /></div>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    <Row gutter={[16, 16]}>
      {statCards.map(card => <Col key={card.title} xs={12} sm={6} xl={3}><Card loading={loading} size="small"><Statistic title={card.title} value={card.value} {...(card.danger ? { valueStyle: { color: '#cf1322' } } : {})} /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{card.sub}</Typography.Text></Card></Col>)}
    </Row>
    <Card title="使用趋势（按日工具调用）" className="analyticsCard">{loading ? <Card loading /> : <TrendChart data={data?.trends ?? []} />}</Card>
    <Card title="成员排行" className="analyticsCard"><Space direction="vertical" size={16} style={{ width: '100%', padding: 16 }}>
      <HBarChart rows={(data?.users ?? []).map(u => ({ label: u.userName, value: u.totalTokens, display: `${fmtNum(u.totalTokens)} · ${u.sessions} 会话` }))} />
      <Table rowKey="userId" loading={loading} columns={userColumns} dataSource={data?.users ?? []} pagination={false} scroll={{ x: 800 }} />
    </Space></Card>
    <Card title="项目产出" className="analyticsCard"><Space direction="vertical" size={16} style={{ width: '100%', padding: 16 }}>
      <HBarChart color="purple" rows={(data?.directories ?? []).map(d => ({ label: d.name, value: d.sessions, display: `${d.sessions} 会话 · ${d.users} 人` }))} />
      <Table rowKey="path" loading={loading} size="middle" columns={dirColumns} dataSource={data?.directories ?? []} pagination={{ pageSize: 6, showSizeChanger: false }} scroll={{ x: 800 }} />
    </Space></Card>
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}><Card title="工具使用" className="analyticsCard"><Space direction="vertical" size={16} style={{ width: '100%', padding: 16 }}>
        <HBarChart color="green" rows={(data?.tools ?? []).map(t => ({ label: t.name, value: t.calls, display: `${t.calls} 次${t.failures > 0 ? ` · 失败 ${t.failures}` : ''}` }))} />
        <Table rowKey="name" loading={loading} size="middle" columns={toolColumns} dataSource={data?.tools ?? []} pagination={{ pageSize: 8, showSizeChanger: false }} />
      </Space></Card></Col>
      <Col xs={24} lg={12}><Card title="模型 Token 占比" className="analyticsCard"><Space direction="vertical" size={16} style={{ width: '100%', padding: 16 }}>
        {loading ? <Card loading /> : <DonutChart models={data?.models ?? []} />}
        <Table rowKey="model" loading={loading} size="middle" columns={modelColumns} dataSource={data?.models ?? []} pagination={false} />
      </Space></Card></Col>
    </Row>
    <Card title="最近会话" className="analyticsCard"><Table rowKey="sessionId" loading={loading} size="middle" columns={recentColumns} dataSource={data?.recentSessions ?? []} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 1000 }} /></Card>
  </Space>
}

async function openDetail(sessionId: string, onOpen: (d: SessionDetail) => void): Promise<void> {
  try {
    const response = await fetch(`/team/admin/insights/sessions/${encodeURIComponent(sessionId)}`)
    const body = await response.json() as SessionDetail & { message?: string }
    if (!response.ok) throw new Error(body.message ?? '加载会话详情失败')
    onOpen(body)
  } catch (error) {
    console.error('加载会话详情失败', error)
  }
}

function SyncStatusPanel() {
  const [data, setData] = useState<SyncStatus>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reconciling, setReconciling] = useState(false)
  const [reconcileResult, setReconcileResult] = useState<string>()
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    void fetch('/team/admin/sync-status').then(async response => {
      const body = await response.json() as SyncStatus & { message?: string }
      if (!response.ok) throw new Error(body.message ?? '加载同步状态失败')
      if (live) setData(body)
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '加载同步状态失败') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])
  const reconcile = async (): Promise<void> => {
    setReconciling(true); setReconcileResult(undefined)
    try {
      const response = await fetch('/team/admin/sync/reconcile', { method: 'POST' })
      const body = await response.json() as { ok?: boolean; message?: string; checked?: number; deleted?: string[]; orphans?: string[]; repaired?: string[] }
      if (!response.ok || body.ok !== true) throw new Error(body.message ?? '对账失败')
      setReconcileResult(`扫描 ${body.checked} · 删除 ${body.deleted?.length ?? 0} · 孤儿 ${body.orphans?.length ?? 0} · 修复标记 ${body.repaired?.length ?? 0}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '对账失败')
    } finally {
      setReconciling(false)
    }
  }
  const userColumns: ColumnsType<SyncUser> = [
    { title: '成员', render: (_, user) => <Space><Avatar shape="square">{user.userName.slice(0, 1)}</Avatar><Typography.Text strong>{user.userName}</Typography.Text><Typography.Text type="secondary">{user.userId}</Typography.Text></Space> },
    { title: '会话数', width: 90, render: (_, user) => user.sessions.length },
    { title: '最后同步', width: 200, render: (_, user) => user.lastSyncAt === null ? <Tag>未同步</Tag> : new Date(user.lastSyncAt).toLocaleString() },
  ]
  const sessionColumns: ColumnsType<SyncSession> = [
    { title: '会话', dataIndex: 'sessionId', render: value => <Typography.Text code copyable>{value}</Typography.Text> },
    { title: '最后同步', width: 200, dataIndex: 'updatedAt', render: value => new Date(value).toLocaleString() },
  ]
  return <Space direction="vertical" size={18} className="analyticsPage">
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    <Row gutter={[16, 16]} className="analyticsStats">
      <Col xs={24} sm={8}><Card loading={loading}><Statistic title="同步用户" value={data?.summary.totalUsers ?? 0} /></Card></Col>
      <Col xs={24} sm={8}><Card loading={loading}><Statistic title="已同步会话" value={data?.summary.totalSessions ?? 0} /></Card></Col>
      <Col xs={24} sm={8}><Card loading={loading}><Statistic title="最后同步" value={data?.summary.lastSyncAt ? new Date(data.summary.lastSyncAt).toLocaleString() : '—'} /></Card></Col>
    </Row>
    <Card title="各用户同步情况" className="analyticsCard" extra={<Button size="small" loading={reconciling} onClick={() => void reconcile()}>对账</Button>}><Table rowKey="userId" loading={loading} columns={userColumns} dataSource={data?.users ?? []} pagination={false} expandable={{ expandedRowRender: user => <Table rowKey="sessionId" size="small" columns={sessionColumns} dataSource={user.sessions} pagination={false} /> }} />{reconcileResult && <Typography.Paragraph style={{ marginTop: 12 }} type="secondary">对账完成：{reconcileResult}</Typography.Paragraph>}</Card>
  </Space>
}

function AccountsPanel({ users, loading, columns }: { users: User[]; loading: boolean; columns: ColumnsType<User> }) {
  return <><Row gutter={16} className="stats"><Col span={8}><Card><Statistic title="全部账号" value={users.length} /></Card></Col><Col span={8}><Card><Statistic title="待审核申请" value={users.filter(user => user.status === 'pending').length} valueStyle={{ color: '#d48806' }} /></Card></Col><Col span={8}><Card><Statistic title="已激活账号" value={users.filter(user => user.status === 'active').length} valueStyle={{ color: '#389e0d' }} /></Card></Col></Row><Card className="tableCard"><Table rowKey="id" columns={columns} dataSource={users} loading={loading} scroll={{ x: 1100 }} pagination={{ pageSize: 10, showSizeChanger: false }} rowClassName={user => user.status === 'pending' ? 'pendingRow' : ''} /></Card></>
}

function SessionOwnershipPanel({ sessions, loading, onOpenSession }: { sessions: SessionOwner[]; loading: boolean; onOpenSession: (d: SessionDetail) => void }) {
  const groups = Object.values(sessions.reduce<Record<string, { userId: string; userName: string; email?: string; sessions: SessionOwner[] }>>((all, session) => { const group = all[session.userId] ?? { userId: session.userId, userName: session.userName, ...(session.email ? { email: session.email } : {}), sessions: [] }; group.sessions.push(session); all[session.userId] = group; return all }, {}))
  const columns: ColumnsType<SessionOwner> = [
    { title: '会话', dataIndex: 'title', render: (_, session) => <div><Typography.Text strong>{session.title ?? '会话记录不可用'}</Typography.Text><div><Typography.Text code copyable type="secondary">{session.sessionId}</Typography.Text></div></div> },
    { title: '更新时间', dataIndex: 'updatedAt', width: 190, render: (_, session) => session.updatedAt === undefined ? '—' : new Date(session.updatedAt).toLocaleString() },
    { title: '操作', width: 90, render: (_, session) => <Button type="link" onClick={() => void openDetail(session.sessionId, onOpenSession)}>分析</Button> },
  ]
  return <><Row gutter={16} className="stats"><Col span={8}><Card><Statistic title="已关联用户" value={groups.length} /></Card></Col><Col span={8}><Card><Statistic title="全部 Session" value={sessions.length} /></Card></Col><Col span={8}><Card><Statistic title="平均每人" value={groups.length ? (sessions.length / groups.length).toFixed(1) : 0} /></Card></Col></Row><Card className="sessionCard" loading={loading}>{groups.length === 0 ? <Empty description="暂无会话归属记录" /> : <Collapse defaultActiveKey={groups.map(group => group.userId)} items={groups.map(group => { const directories = Object.values(group.sessions.reduce<Record<string, { cwd?: string; sessions: SessionOwner[] }>>((all, session) => { const key = session.cwd ?? '__ungrouped__'; const directory = all[key] ?? { ...(session.cwd === undefined ? {} : { cwd: session.cwd }), sessions: [] }; directory.sessions.push(session); all[key] = directory; return all }, {})); return { key: group.userId, label: <div className="userGroupLabel"><Space><Avatar shape="square">{group.userName.slice(0, 1)}</Avatar><div><Typography.Text strong>{group.userName}</Typography.Text><Typography.Text type="secondary" className="blockText">{group.email ?? group.userId}</Typography.Text></div></Space><Tag color="blue">{group.sessions.length} 个 Session</Tag></div>, children: <Collapse className="directoryGroups" defaultActiveKey={directories.map(directory => directory.cwd ?? '__ungrouped__')} items={directories.map(directory => ({ key: directory.cwd ?? '__ungrouped__', label: <div className="directoryLabel"><div><Typography.Text strong>{directory.cwd === undefined ? '未分组' : directory.cwd.split(/[\\/]/).filter(Boolean).at(-1)}</Typography.Text>{directory.cwd !== undefined && <Typography.Text code copyable={{ text: directory.cwd }} type="secondary" className="directoryPath">{directory.cwd}</Typography.Text>}</div><Tag>{directory.sessions.length} 个会话</Tag></div>, children: <Table rowKey="sessionId" size="middle" columns={columns} dataSource={directory.sessions} pagination={false} /> }))} /> } })} />}</Card></>
}

function Centered({ children }: { children: React.ReactNode }) { return <div className="centered">{children}</div> }
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{ token: { colorPrimary: '#1677ff', borderRadius: 10 }, components: { Layout: { siderBg: '#fff', headerBg: '#fff' }, Menu: { itemBorderRadius: 8 } } }}><AntApp><AdminRoot /></AntApp></ConfigProvider>)
