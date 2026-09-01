import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, App as AntApp, Avatar, Button, Card, Col, Collapse, ConfigProvider, Drawer, Empty, Input, Layout, Menu, Popconfirm, Row, Segmented, Select, Space, Statistic, Table, Tabs, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'

type Role = 'admin' | 'developer' | 'reviewer' | 'user'
type Status = 'pending' | 'active' | 'rejected' | 'disabled'
type User = { id: string; email?: string; name: string; status: Status; role: Role; password?: string }
type SessionOwner = { sessionId: string; userId: string; userName: string; email?: string; createdAt: string; lastActiveAt: string; title?: string; projectName?: string; gitRemote?: string; updatedAt?: number; blank?: boolean }
type Phase = 'checking' | 'ready'
type Section = 'dashboard' | 'users' | 'projects' | 'accounts'

// ── 总览类型（/team/admin/overview）──────────────────────────
type OverviewSummary = {
  sessions: number; activeUsers: number; projects: number
  userMessages: number; assistantMessages: number
  toolCalls: number; toolFailures: number; toolFailureRate: number
  modelRequests: number; inputTokens: number; outputTokens: number; totalTokens: number
  gatewayRequests: number; gatewayTokens: number; costCny: number
  activeDurationMs: number; durationMs: number; errors: number
  commits: number; insertions: number; deletions: number
}
type OverviewTrend = { date: string; sessions: number; activeUsers: number; toolCalls: number; modelRequests: number; totalTokens: number }
type OverviewTool = { name: string; calls: number; failures: number; users: number }
type OverviewModel = { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }
type OverviewCommit = { userId: string; userName: string; commitHash: string; gitRemote?: string; subject?: string; files: number; insertions: number; deletions: number; time: number }
type OverviewUser = { userId: string; userName: string; sessions: number; projects: number; messages: number; toolCalls: number; toolFailures: number; modelRequests: number; totalTokens: number; durationMs: number; errors: number; lastActiveAt: number; models: OverviewModel[]; tools: Omit<OverviewTool, 'users'>[]; commits: OverviewCommit[]; insertions: number; deletions: number; lastCommitAt: number }
type OverviewDirectory = { id: string; name: string; gitRemote: string; sessions: number; users: number; members: { userId: string; userName: string }[]; messages: number; toolCalls: number; toolFailures: number; modelRequests: number; totalTokens: number; durationMs: number; errors: number; lastActiveAt: number; models: OverviewModel[]; tools: Omit<OverviewTool, 'users'>[]; commits: OverviewCommit[]; insertions: number; deletions: number; lastCommitAt: number }
type OverviewRecent = { sessionId: string; title: string; userId: string; userName: string; gitRemote?: string; models: { model: string; requests: number }[]; lastActiveAt: number; toolCalls: number; durationMs: number; errorCount: number }
type Overview = {
  rangeDays: number; generatedAt: string; summary: OverviewSummary
  trends: OverviewTrend[]; users: OverviewUser[]; directories: OverviewDirectory[]
  tools: OverviewTool[]; models: OverviewModel[]; recentSessions: OverviewRecent[]
}

// ── 会话详情类型（/team/admin/insights/sessions/:id）─────────
type SessionMetrics = {
  userMessages: number; assistantMessages: number; toolCalls: number; toolFailures: number
  turnCount: number; stepCount: number; errorCount: number; durationMs: number; activeDurationMs: number
  firstTime: number; lastTime: number
  tools: { name: string; calls: number; failures: number; totalMs: number; avgMs: number; maxMs: number }[]
  models: { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }[]
  timeline: { time: number; kind: string; label: string; status?: string }[]
  toolEvents: { time: number; name: string; failed: boolean; durationMs?: number }[]
  modelEvents: { time: number; model: string; inputTokens: number; outputTokens: number; totalTokens: number }[]
}
type SessionDetail = { session: SessionOwner; metrics: SessionMetrics; timeline: SessionMetrics['timeline'] }

type SyncSession = { sessionId: string; updatedAt: string; title?: string }
type SyncUser = { userId: string; userName: string; sessions: SyncSession[]; lastSyncAt: string | null }
type SyncStatus = { generatedAt: string; summary: { totalUsers: number; totalSessions: number; lastSyncAt: string | null }; users: SyncUser[] }

// ── AI 用量类型（/team/admin/usage）──────────────────────────
type UsageModel = { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number; costCny: number; failed: number; avgLatencyMs: number }
type UsageUser = { userId: string; userName: string; requests: number; totalTokens: number; costCny: number }
type UsageRow = { requestId: string; userId: string; userName: string; model: string; inputTokens: number; outputTokens: number; costCny: number; latencyMs: number; status: number; createdAt: string }
type Usage = {
  rangeDays: number; generatedAt: string
  summary: { requests: number; totalTokens: number; inputTokens: number; outputTokens: number; costCny: number; failed: number; avgLatencyMs: number }
  models: UsageModel[]; users: UsageUser[]; recent: UsageRow[]
}

// ── 项目详情类型（/team/admin/projects/:remote）──────────────
type ProjectDetailCommit = { userId: string; userName: string; commitHash: string; gitRemote?: string; authorName?: string; authorEmail?: string; subject?: string; message?: string; changedFiles?: string[]; files: number; insertions: number; deletions: number; time: number; type: string }
/** Drawer 入口引用：仅携带定位信息，实际数据按需拉取。 */
type ProjectDetailRef = { gitRemote: string; projectName?: string }
type ProjectDetail = {
  gitRemote: string; projectName: string; rangeDays: number; generatedAt: string
  summary: { commits: number; activeDevelopers: number; activeDays: number; insertions: number; deletions: number; lastCommitAt: number; topChangedFiles: number }
  trend: { day: string; commits: number; insertions: number; deletions: number }[]
  authors: { authorEmail: string; authorName: string; commits: number; insertions: number; deletions: number; boundUserName?: string }[]
  commitTypes: { type: string; count: number }[]
  hotDirectories: { directory: string; count: number }[]
  commits: ProjectDetailCommit[]
}

// ── 用户详情类型（/team/admin/user-detail/:userId）────────────
type UserDetail = {
  userId: string; userName: string; rangeDays: number; generatedAt: string
  summary: { commits: number; insertions: number; deletions: number; activeDays: number; activeProjects: number; sessions: number; toolCalls: number; toolFailures: number; modelRequests: number; totalTokens: number; costCny: number; lastActiveAt: number }
  projects: { gitRemote: string; projectName: string; commits: number; hasSessions: boolean }[]
  models: { model: string; requests: number; inputTokens: number; outputTokens: number; costCny: number }[]
  commits: ProjectDetailCommit[]
  recentSessions: { sessionId: string; title: string; lastActiveAt: number; toolCalls: number; toolFailures: number; gitRemote?: string }[]
}
/** Drawer 入口引用：仅携带定位信息，实际数据按需拉取。 */
type UserDetailRef = { userId: string; userName?: string }

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

function SessionModels({ models }: { models: OverviewRecent['models'] }) {
  if (models.length === 0) return <Typography.Text type="secondary">—</Typography.Text>
  const visible = models.slice(0, 2)
  return <Space size={[4, 4]} wrap>
    {visible.map(model => <Tag color="blue" key={model.model} title={`${model.model} · ${model.requests} 次请求`} style={{ maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis' }}>{model.model}{model.requests > 1 ? ` ×${model.requests}` : ''}</Tag>)}
    {models.length > visible.length && <Tag title={models.slice(visible.length).map(model => model.model).join('\n')}>+{models.length - visible.length}</Tag>}
  </Space>
}
/** 按日对比工具调用与模型请求。 */
function TrendChart({ data }: { data: OverviewTrend[] }) {
  const max = Math.max(1, ...data.flatMap(d => [d.toolCalls, d.modelRequests]))
  return <>
    <div className="chartLegend"><span><i className="legendTool" />工具调用</span><span><i className="legendModel" />模型请求</span></div>
    <div className="chart-trend">
      {data.map(d => <div key={d.date} className="trendGroup">
        <div className="trendBars">
          <div className={d.toolCalls === 0 ? 'bar tool empty' : 'bar tool'} style={{ height: `${Math.max(3, Math.round(d.toolCalls / max * 100))}%` }}><span className="v">{d.toolCalls}</span></div>
          <div className={d.modelRequests === 0 ? 'bar model empty' : 'bar model'} style={{ height: `${Math.max(3, Math.round(d.modelRequests / max * 100))}%` }}><span className="v">{d.modelRequests}</span></div>
        </div>
        <span className="d">{d.date.slice(5)}</span>
      </div>)}
    </div>
  </>
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
  useEffect(() => { if (section === 'dashboard' && canEdit) void loadSessions() }, [section, canEdit])

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
    ? { title: '总览', description: '团队 AI 全景：活跃度、AI 用量、Agent 会话' }
    : section === 'users'
      ? { title: '用户', description: '按成员查看参与项目、研发活动与 AI 消耗' }
    : section === 'projects'
      ? { title: '项目', description: '按 Git 项目查看提交趋势、作者分布与 AI 使用' }
      : { title: '账号与权限', description: '账号申请审核、角色权限、Git 邮箱映射与同步状态' }
  const menuItems = [
    { key: 'dashboard' as Section, label: <span className="aiMenuLabel"><i className="aiDot dot-blue" />总览</span> },
    { key: 'users' as Section, label: <span className="aiMenuLabel"><i className="aiDot dot-purple" />用户</span> },
    { key: 'projects' as Section, label: <span className="aiMenuLabel"><i className="aiDot dot-green" />项目</span> },
    { key: 'accounts' as Section, label: <span className="aiMenuLabel"><i className="aiDot dot-orange" />账号与权限</span> },
  ]
  return <><Layout className="page">{contextHolder}<Layout.Sider width={240} theme="light" className="adminSider"><div className="brand"><div className="brandMark">✦</div><div><Typography.Text strong className="aiBrandName">HiveMind · AI 研发平台</Typography.Text><Typography.Text type="secondary" className="blockText">团队智能控制台</Typography.Text></div></div><Menu mode="inline" selectedKeys={[section]} onSelect={({ key }) => { setSection(key as Section); document.getElementById('admin-main-scroll')?.scrollTo({ top: 0 }) }} items={canEdit ? menuItems : [menuItems[3]!]} /><div className="siderUser"><Avatar className="aiAvatar">{currentUser?.name.slice(0, 1)}</Avatar><div><Typography.Text strong>{currentUser?.name}</Typography.Text><Typography.Text type="secondary" className="blockText">{roleOptions.find(item => item.value === currentUser?.role)?.label}</Typography.Text></div></div></Layout.Sider><Layout id="admin-main-scroll" className="mainLayout"><Layout.Header className="topbar"><div><Typography.Title level={3}>{sectionCopy.title}</Typography.Title><Typography.Text type="secondary">{sectionCopy.description}</Typography.Text></div><Space><Tag className="aiStatusTag" color="blue">● 数据同步中</Tag><Button onClick={() => void logout()}>退出登录</Button></Space></Layout.Header><Layout.Content className="content">{section === 'dashboard' ? <DashboardSection sessions={sessions} loading={loading} onOpenSession={setDetail} /> : section === 'users' ? <UserDataPanel onOpenSession={setDetail} /> : section === 'projects' ? <ProjectDataPanel onOpenSession={setDetail} /> : <><AccountsPanel users={users} loading={loading} columns={columns} />{canEdit && <GitEmailsPanel />}{canEdit && <SyncStatusPanel />}</>}</Layout.Content></Layout></Layout><SessionDetailDrawer detail={detail} onClose={() => setDetail(undefined)} /></>
}

/** 会话详情抽屉：完整指标 + 分组时间线 + 工具耗时。 */
function SessionDetailDrawer({ detail, onClose }: { detail: SessionDetail | undefined; onClose: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  useEffect(() => { setSelectedIndex(0) }, [detail?.session.sessionId])
  if (detail === undefined) return null
  const m = detail.metrics
  const timeline = m.timeline.map((item, index) => {
    const model = item.kind === 'assistant' ? m.modelEvents.find(event => event.time === item.time) : undefined
    const tool = item.kind === 'tool' ? m.toolEvents.find(event => event.time === item.time) : item.kind === 'result' ? m.toolEvents.find(event => event.durationMs !== undefined && event.time + event.durationMs === item.time) : undefined
    return { ...item, index, model, tool }
  })
  const selected = timeline[Math.min(selectedIndex, Math.max(0, timeline.length - 1))]
  const kindMeta: Record<string, { label: string; tone: string }> = {
    turn: { label: '轮次', tone: 'purple' }, step: { label: '步骤', tone: 'cyan' }, user: { label: '用户', tone: 'blue' },
    assistant: { label: '助手', tone: 'purple' }, model: { label: '模型', tone: 'slate' }, tool: { label: '工具', tone: 'orange' },
    result: { label: '结果', tone: 'green' }, error: { label: '错误', tone: 'red' },
  }
  const metricCards = [
    { title: '消息', value: `${m.userMessages + m.assistantMessages}`, detail: `${m.userMessages} 用户 · ${m.assistantMessages} 助手` },
    { title: '轮次 / 步骤', value: `${m.turnCount} / ${m.stepCount}`, detail: '完整执行结构' },
    { title: '工具调用', value: `${m.toolCalls}`, detail: m.toolFailures > 0 ? `${m.toolFailures} 次失败` : '全部成功' },
    { title: '活跃时长', value: fmt(m.activeDurationMs), detail: `会话跨度 ${fmt(m.durationMs)}` },
    { title: 'Token', value: fmtNum(m.models.reduce((sum, model) => sum + model.totalTokens, 0)), detail: `${m.models.reduce((sum, model) => sum + model.requests, 0)} 次模型请求` },
  ]
  return <Drawer title={null} open onClose={onClose} width="min(1180px, 94vw)" className="trajectoryDrawer" destroyOnHidden>
    <div className="trajectoryHeader">
      <div><Typography.Title level={4}>{detail.session.title ?? '会话详情'}</Typography.Title><Space size={6} wrap><Tag>{detail.session.userName}</Tag>{detail.session.gitRemote !== undefined && <Typography.Text code copyable={{ text: detail.session.gitRemote }} ellipsis className="trajectoryRepo">{detail.session.gitRemote}</Typography.Text>}<Typography.Text type="secondary">{new Date(detail.session.createdAt).toLocaleString()}</Typography.Text></Space></div>
      <Typography.Text code copyable type="secondary">{detail.session.sessionId}</Typography.Text>
    </div>
    <div className="trajectoryMetrics">{metricCards.map(card => <div key={card.title}><span>{card.title}</span><strong>{card.value}</strong><small>{card.detail}</small></div>)}</div>
    {m.models.length > 0 && <div className="trajectoryModels"><Typography.Text type="secondary">使用模型</Typography.Text>{m.models.map(model => <Tag color="blue" key={model.model}>{model.model} · {model.requests} 次 · {fmtNum(model.totalTokens)} Token</Tag>)}</div>}
    <div className="trajectoryRail" aria-label="会话轨迹概览">
      {timeline.map(item => <button key={`${item.time}-${item.index}`} title={`${kindMeta[item.kind]?.label ?? item.kind} · ${item.label}`} className={`railBlock ${kindMeta[item.kind]?.tone ?? 'slate'} ${item.status === 'failed' ? 'failed' : ''} ${item.index === selected?.index ? 'active' : ''}`} onClick={() => setSelectedIndex(item.index)} />)}
    </div>
    <div className="trajectoryBody">
      <section className="trajectoryList">
        <div className="trajectoryListHead"><strong>过程轨迹</strong><Typography.Text type="secondary">仅展示类型、工具、模型、用量与状态，不含对话内容</Typography.Text></div>
        {timeline.length === 0 ? <Empty description="没有可展示的事件" /> : timeline.map(item => {
          const meta = kindMeta[item.kind] ?? { label: item.kind, tone: 'slate' }
          const detailText = item.model !== undefined ? `${item.model.model} · ${fmtNum(item.model.totalTokens)} Token` : item.tool?.durationMs !== undefined ? fmt(item.tool.durationMs) : undefined
          return <button key={`${item.time}-${item.index}`} className={`trajectoryRow ${item.index === selected?.index ? 'selected' : ''}`} onClick={() => setSelectedIndex(item.index)}>
            <span className={`trajectoryDot ${meta.tone} ${item.status === 'failed' ? 'failed' : ''}`} />
            <Tag bordered={false} className={`trajectoryKind ${meta.tone}`}>{meta.label}</Tag>
            <span className="trajectoryLabel">{item.label}</span>
            {detailText !== undefined && <span className="trajectoryHint">{detailText}</span>}
            <time>{new Date(item.time).toLocaleTimeString()}</time>
          </button>
        })}
      </section>
      <aside className="trajectoryInspector">
        {selected === undefined ? <Empty description="选择一个事件查看详情" /> : <>
          <div className="inspectorTitle"><Tag bordered={false} className={`trajectoryKind ${kindMeta[selected.kind]?.tone ?? 'slate'}`}>{kindMeta[selected.kind]?.label ?? selected.kind}</Tag><Typography.Title level={5}>{selected.label}</Typography.Title></div>
          <dl>
            <div><dt>状态</dt><dd>{selected.status === 'failed' ? <Tag color="red">失败</Tag> : <Tag color="green">已完成</Tag>}</dd></div>
            <div><dt>时间</dt><dd>{new Date(selected.time).toLocaleString()}</dd></div>
            <div><dt>序号</dt><dd>事件 #{selected.index + 1}</dd></div>
            {selected.model !== undefined && <><div><dt>模型</dt><dd>{selected.model.model}</dd></div><div><dt>Token</dt><dd>{fmtNum(selected.model.totalTokens)}（输入 {fmtNum(selected.model.inputTokens)} / 输出 {fmtNum(selected.model.outputTokens)}）</dd></div></>}
            {selected.tool !== undefined && <><div><dt>工具</dt><dd>{selected.tool.name}</dd></div><div><dt>耗时</dt><dd>{selected.tool.durationMs === undefined ? '执行中或无结果' : fmt(selected.tool.durationMs)}</dd></div></>}
          </dl>
          {selected.kind === 'tool' && selected.tool !== undefined && <div className="inspectorSummary"><Typography.Text type="secondary">工具调用摘要</Typography.Text><strong>{selected.tool.failed ? '执行失败' : '执行成功'}</strong><span>管理后台不会展示命令参数、文件内容或工具返回正文。</span></div>}
          {selected.kind === 'assistant' && selected.model !== undefined && <div className="inspectorSummary"><Typography.Text type="secondary">模型请求摘要</Typography.Text><strong>{fmtNum(selected.model.totalTokens)} Token</strong><span>仅保留模型标识和用量指标，不保存或展示回复正文。</span></div>}
        </>}
      </aside>
    </div>
  </Drawer>
}

/** 总览：统一指标卡 + 趋势 + 用户/项目/工具/模型排行 + 最近会话。 */
/** 总览页：Tab 合并 团队总览 / AI 用量 / Agent 会话。 */
function DashboardSection({ sessions, loading, onOpenSession }: { sessions: SessionOwner[]; loading: boolean; onOpenSession: (d: SessionDetail) => void }) {
  return <Tabs className="aiTabs" defaultActiveKey="overview" items={[
    { key: 'overview', label: <span className="aiTabLabel"><i className="aiDot dot-blue" />团队总览</span>, children: <DashboardPanel onOpenSession={onOpenSession} /> },
    { key: 'usage', label: <span className="aiTabLabel"><i className="aiDot dot-purple" />AI 用量</span>, children: <UsagePanel /> },
    { key: 'sessions', label: <span className="aiTabLabel"><i className="aiDot dot-green" />Agent 会话</span>, children: <SessionOwnershipPanel sessions={sessions} loading={loading} onOpenSession={onOpenSession} /> },
  ]} />
}

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
  const toolSuccessRate = Math.max(0, 100 - (s?.toolFailureRate ?? 0))
  const avgTokens = (s?.modelRequests ?? 0) === 0 ? 0 : Math.round((s?.totalTokens ?? 0) / (s?.modelRequests ?? 1))
  const avgActiveTime = (s?.sessions ?? 0) === 0 ? 0 : Math.round((s?.activeDurationMs ?? 0) / (s?.sessions ?? 1))
  const topUser = data?.users[0]
  const topModel = data?.models[0]
  const failedTools = (data?.tools ?? []).filter(tool => tool.failures > 0)
  const primaryStats = [
    { tone: 'blue', label: '团队活跃', value: s?.activeUsers ?? 0, unit: '人', detail: `${s?.sessions ?? 0} 个会话` },
    { tone: 'purple', label: 'AI 消耗', value: fmtNum(s?.totalTokens ?? 0), unit: 'Token', detail: `${s?.modelRequests ?? 0} 次模型请求` },
    { tone: toolSuccessRate < 95 ? 'orange' : 'green', label: '工具成功率', value: `${toolSuccessRate}%`, unit: '', detail: `${s?.toolCalls ?? 0} 次调用 · ${s?.toolFailures ?? 0} 次失败` },
    { tone: (s?.errors ?? 0) > 0 ? 'red' : 'green', label: '运行健康', value: s?.errors ?? 0, unit: '错误', detail: (s?.errors ?? 0) > 0 ? '存在需要关注的异常' : '当前范围内运行正常' },
  ]
  const secondaryStats = [
    { label: '活跃项目', value: String(s?.projects ?? 0), detail: 'Git 远程仓库' },
    { label: 'Git 提交', value: String(s?.commits ?? 0), detail: `+${s?.insertions ?? 0} / -${s?.deletions ?? 0}` },
    { label: '对话消息', value: String((s?.userMessages ?? 0) + (s?.assistantMessages ?? 0)), detail: `${s?.userMessages ?? 0} 用户 · ${s?.assistantMessages ?? 0} 助手` },
    { label: '平均请求消耗', value: fmtNum(avgTokens), detail: 'Token / 请求' },
    { label: 'AI 成本', value: fmtCny(s?.costCny ?? 0), detail: `网关 ${s?.gatewayRequests ?? 0} 次请求` },
    { label: '平均会话活跃', value: fmt(avgActiveTime), detail: `累计 ${fmt(s?.activeDurationMs ?? 0)}` },
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
    { title: '项目', render: (_, d) => <div><Typography.Text strong>{d.name}</Typography.Text><Typography.Text code copyable={{ text: d.gitRemote }} type="secondary" className="blockText">{d.gitRemote}</Typography.Text></div> },
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
    { title: '项目', dataIndex: 'gitRemote', ellipsis: true, render: v => v === undefined ? '未关联 Git 项目' : <Typography.Text code copyable={{ text: v }} ellipsis={{ tooltip: v }}>{v}</Typography.Text> },
    { title: '模型', width: 230, render: (_, r) => <SessionModels models={r.models ?? []} /> },
    { title: '工具', dataIndex: 'toolCalls', width: 80 },
    { title: '最后活跃', dataIndex: 'lastActiveAt', width: 170, render: v => new Date(v).toLocaleString() },
    { title: '时长', width: 90, render: (_, r) => fmt(r.durationMs) },
    { title: '错误', dataIndex: 'errorCount', width: 70, render: v => v === 0 ? '—' : <Tag color="red">{v}</Tag> },
    { title: '操作', width: 90, render: (_, r) => <Button type="link" onClick={() => void openDetail(r.sessionId, onOpenSession)}>详情</Button> },
  ]
  return <Space direction="vertical" size={18} className="analyticsPage">
    <section className="overviewHero">
      <div className="overviewHeroHead"><div><Typography.Text className="eyebrow">TEAM PULSE</Typography.Text><Typography.Title level={4}>团队运行概况</Typography.Title><Typography.Text type="secondary">聚焦活跃、消耗、成功率与异常</Typography.Text></div><div className="rangeControl"><Typography.Text type="secondary">统计范围</Typography.Text><Segmented value={days} onChange={value => setDays(value as 1 | 7 | 30)} options={[{ label: '24 小时', value: 1 }, { label: '7 天', value: 7 }, { label: '30 天', value: 30 }]} /></div></div>
      <Row gutter={[14, 14]} className="primaryMetrics">
        {primaryStats.map(card => <Col key={card.label} xs={24} sm={12} xl={6}><Card loading={loading} className={`metricCard ${card.tone}`}><Typography.Text type="secondary">{card.label}</Typography.Text><div className="metricValue">{card.value}<small>{card.unit}</small></div><Typography.Text type="secondary">{card.detail}</Typography.Text></Card></Col>)}
      </Row>
      <div className="secondaryMetrics">{secondaryStats.map(item => <div key={item.label}><Typography.Text type="secondary">{item.label}</Typography.Text><strong>{item.value}</strong><span>{item.detail}</span></div>)}</div>
    </section>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={16}><Card title="活动趋势" extra={<Typography.Text type="secondary">按日对比</Typography.Text>} className="analyticsCard trendCard">{loading ? <Card loading /> : <TrendChart data={data?.trends ?? []} />}</Card></Col>
      <Col xs={24} xl={8}><Card title="运行健康" className="analyticsCard healthCard" extra={<span className={`healthBadge ${(s?.errors ?? 0) > 0 || failedTools.length > 0 ? 'warn' : 'ok'}`}>{(s?.errors ?? 0) > 0 || failedTools.length > 0 ? '需关注' : '状态良好'}</span>}>
        <div className="healthList">
          <div><span>错误事件</span><strong className={(s?.errors ?? 0) > 0 ? 'dangerText' : ''}>{s?.errors ?? 0}</strong></div>
          <div><span>异常工具种类</span><strong className={failedTools.length > 0 ? 'warningText' : ''}>{failedTools.length}</strong></div>
          <div><span>主要模型</span><strong title={topModel?.model}>{topModel?.model ?? '—'}</strong></div>
          <div><span>最活跃成员</span><strong>{topUser === undefined ? '—' : `${topUser.userName} · ${fmtNum(topUser.totalTokens)}`}</strong></div>
        </div>
        <div className="healthFoot">更新于 {data?.generatedAt === undefined ? '—' : new Date(data.generatedAt).toLocaleTimeString()}</div>
      </Card></Col>
    </Row>
    <Card title="最近会话" extra={<Typography.Text type="secondary">优先查看错误与最新活动</Typography.Text>} className="analyticsCard"><Table rowKey="sessionId" loading={loading} size="middle" columns={recentColumns} dataSource={[...(data?.recentSessions ?? [])].sort((a, b) => b.errorCount - a.errorCount || b.lastActiveAt - a.lastActiveAt)} pagination={{ pageSize: 6, showSizeChanger: false }} scroll={{ x: 1230 }} /></Card>
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={12}><Card title="成员贡献" className="analyticsCard"><Space direction="vertical" size={16} style={{ width: '100%', padding: 16 }}>
      <HBarChart rows={(data?.users ?? []).map(u => ({ label: u.userName, value: u.totalTokens, display: `${fmtNum(u.totalTokens)} · ${u.sessions} 会话` }))} />
      <Table rowKey="userId" loading={loading} columns={userColumns} dataSource={data?.users ?? []} pagination={false} scroll={{ x: 800 }} />
    </Space></Card></Col>
      <Col xs={24} xl={12}><Card title="活跃项目" className="analyticsCard"><Space direction="vertical" size={16} style={{ width: '100%', padding: 16 }}>
      <HBarChart color="purple" rows={(data?.directories ?? []).map(d => ({ label: d.name, value: d.sessions, display: `${d.sessions} 会话 · ${d.users} 人` }))} />
      <Table rowKey="id" loading={loading} size="middle" columns={dirColumns} dataSource={data?.directories ?? []} pagination={{ pageSize: 6, showSizeChanger: false }} scroll={{ x: 800 }} />
    </Space></Card></Col>
    </Row>
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
  </Space>
}

const fmtCny = (value: number): string => value >= 1 ? `¥${value.toFixed(2)}` : value === 0 ? '¥0.00' : `¥${value.toFixed(4)}`

/** AI 用量页：网关采集的模型请求/Token/成本，按模型与用户分布。 */
function UsagePanel() {
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const [data, setData] = useState<Usage>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    void fetch(`/team/admin/usage?days=${days}`).then(async response => {
      const body = await response.json() as Usage & { message?: string }
      if (!response.ok) throw new Error(body.message ?? '加载 AI 用量失败')
      if (live) setData(body)
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '加载 AI 用量失败') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [days])

  const s = data?.summary
  const stats = [
    { label: '模型请求', value: String(s?.requests ?? 0), detail: `${s?.failed ?? 0} 次失败` },
    { label: '总 Token', value: fmtNum(s?.totalTokens ?? 0), detail: `输入 ${fmtNum(s?.inputTokens ?? 0)} · 输出 ${fmtNum(s?.outputTokens ?? 0)}` },
    { label: '成本（估算）', value: fmtCny(s?.costCny ?? 0), detail: '按模型官方价计算' },
    { label: '平均延迟', value: s === undefined ? '—' : fmt(s.avgLatencyMs), detail: '网关到模型耗时' },
  ]
  const modelColumns: ColumnsType<UsageModel> = [
    { title: '模型', dataIndex: 'model', ellipsis: true },
    { title: '请求', dataIndex: 'requests', width: 90 },
    { title: '输入 Token', dataIndex: 'inputTokens', width: 120, render: v => fmtNum(v) },
    { title: '输出 Token', dataIndex: 'outputTokens', width: 120, render: v => fmtNum(v) },
    { title: '总 Token', dataIndex: 'totalTokens', width: 120, render: v => fmtNum(v) },
    { title: '成本', dataIndex: 'costCny', width: 100, render: v => fmtCny(v) },
    { title: '失败', dataIndex: 'failed', width: 80, render: v => v === 0 ? '—' : <Tag color="red">{v}</Tag> },
  ]
  const userColumns: ColumnsType<UsageUser> = [
    { title: '成员', render: (_, u) => <Space><Avatar shape="square">{u.userName.slice(0, 1)}</Avatar><Typography.Text strong>{u.userName}</Typography.Text><Typography.Text type="secondary">{u.userId}</Typography.Text></Space> },
    { title: '请求', dataIndex: 'requests', width: 90 },
    { title: '总 Token', dataIndex: 'totalTokens', width: 120, render: v => fmtNum(v) },
    { title: '成本', dataIndex: 'costCny', width: 100, render: v => fmtCny(v) },
  ]
  const recentColumns: ColumnsType<UsageRow> = [
    { title: '时间', dataIndex: 'createdAt', width: 180, render: v => new Date(v).toLocaleString() },
    { title: '成员', width: 130, render: (_, r) => r.userName },
    { title: '模型', dataIndex: 'model', ellipsis: true },
    { title: '输入', dataIndex: 'inputTokens', width: 90, render: v => fmtNum(v) },
    { title: '输出', dataIndex: 'outputTokens', width: 90, render: v => fmtNum(v) },
    { title: '成本', dataIndex: 'costCny', width: 100, render: v => fmtCny(v) },
    { title: '延迟', width: 90, render: (_, r) => fmt(r.latencyMs) },
    { title: '状态', width: 80, render: (_, r) => r.status >= 400 ? <Tag color="red">{r.status}</Tag> : <Tag color="green">{r.status}</Tag> },
  ]
  return <Space direction="vertical" size={18} className="analyticsPage">
    <DimensionToolbar days={days} onChange={setDays} />
    {error && <Alert type="error" showIcon message={error} />}
    <Row gutter={[16, 16]} className="analyticsStats">
      {stats.map(stat => <Col key={stat.label} xs={12} lg={6}><Card loading={loading}><Statistic title={stat.label} value={stat.value} /><Typography.Text type="secondary">{stat.detail}</Typography.Text></Card></Col>)}
    </Row>
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={14}><Card title="模型用量与成本" className="analyticsCard"><Space direction="vertical" size={16} style={{ width: '100%', padding: 16 }}>
        <HBarChart color="purple" rows={(data?.models ?? []).map(m => ({ label: m.model, value: m.totalTokens, display: `${m.requests} 请求 · ${fmtCny(m.costCny)}` }))} />
        <Table rowKey="model" loading={loading} size="middle" columns={modelColumns} dataSource={data?.models ?? []} pagination={false} scroll={{ x: 800 }} />
      </Space></Card></Col>
      <Col xs={24} xl={10}><Card title="成员 AI 消耗" className="analyticsCard"><Table rowKey="userId" loading={loading} size="middle" columns={userColumns} dataSource={data?.users ?? []} pagination={false} /></Card></Col>
    </Row>
    <Card title="最近模型请求" extra={<Typography.Text type="secondary">网关记录 · 非会话内 Token 统计</Typography.Text>} className="analyticsCard"><Table rowKey="requestId" loading={loading} size="middle" columns={recentColumns} dataSource={data?.recent ?? []} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 1000 }} /></Card>
  </Space>
}

const COMMIT_TYPE_META: Record<string, { label: string; color: string }> = {
  feat: { label: '新功能', color: 'blue' }, fix: { label: 'Bug 修复', color: 'red' }, refactor: { label: '重构', color: 'purple' },
  chore: { label: '维护', color: 'default' }, docs: { label: '文档', color: 'cyan' }, test: { label: '测试', color: 'green' }, other: { label: '其他', color: 'gold' },
}

/** 项目详情抽屉：Commit 趋势/作者分布/活跃目录/类型分布/最近提交。 */
function ProjectDetailDrawer({ detail, onClose }: { detail: ProjectDetailRef | undefined; onClose: () => void }) {
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const [data, setData] = useState<ProjectDetail>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (detail === undefined) return
    let live = true
    setLoading(true); setError('')
    void fetch(`/team/admin/projects/${encodeURIComponent(detail.gitRemote)}?days=${days}`).then(async response => {
      const body = await response.json() as ProjectDetail & { message?: string }
      if (!response.ok) throw new Error(body.message ?? '加载项目详情失败')
      if (live) setData(body)
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '加载项目详情失败') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [detail, days])
  const s = data?.summary
  const trendMax = Math.max(1, ...(data?.trend ?? []).map(item => item.commits))
  const typeTotal = (data?.commitTypes ?? []).reduce((sum, item) => sum + item.count, 0)
  const authorColumns: ColumnsType<ProjectDetail['authors'][number]> = [
    { title: '作者', render: (_, author) => <Space><Avatar shape="square" size="small">{author.authorName.slice(0, 1)}</Avatar><div><Typography.Text strong>{author.authorName}</Typography.Text><Typography.Text code copyable type="secondary" className="blockText">{author.authorEmail}</Typography.Text>{author.boundUserName !== undefined && <Tag color="green">已绑定：{author.boundUserName}</Tag>}</div></Space> },
    { title: '提交', dataIndex: 'commits', width: 90 },
    { title: '代码增删', width: 130, render: (_, author) => <span><Typography.Text type="success">+{author.insertions}</Typography.Text> <Typography.Text type="danger">-{author.deletions}</Typography.Text></span> },
  ]
  const commitColumns: ColumnsType<ProjectDetailCommit> = [
    { title: '提交', width: 90, render: (_, commit) => <Typography.Text code copyable>{commit.commitHash.slice(0, 8)}</Typography.Text> },
    { title: '作者', width: 140, render: (_, commit) => commit.authorName ?? commit.userName },
    { title: '说明', render: (_, commit) => <div><Typography.Text>{commit.subject ?? commit.message ?? '—'}</Typography.Text>{commit.changedFiles !== undefined && commit.changedFiles.length > 0 && <Typography.Text type="secondary" className="blockText">{commit.changedFiles.slice(0, 5).join(' · ')}{commit.changedFiles.length > 5 ? ` +${commit.changedFiles.length - 5}` : ''}</Typography.Text>}</div> },
    { title: '类型', width: 90, render: (_, commit) => { const meta = COMMIT_TYPE_META[commit.type] ?? COMMIT_TYPE_META['other']!; return <Tag color={meta.color}>{meta.label}</Tag> } },
    { title: '增删', width: 120, render: (_, commit) => <span><Typography.Text type="success">+{commit.insertions}</Typography.Text> <Typography.Text type="danger">-{commit.deletions}</Typography.Text></span> },
    { title: '时间', width: 170, dataIndex: 'time', render: value => new Date(value).toLocaleString() },
  ]
  return <Drawer width={Math.min(1180, window.innerWidth)} open={detail !== undefined} onClose={onClose} className="trajectoryDrawer" title={detail === undefined ? '' : <span>{data?.projectName ?? detail.projectName ?? detail.gitRemote} <Typography.Text type="secondary">项目详情</Typography.Text></span>} extra={<Segmented value={days} onChange={value => setDays(value as 7 | 30 | 90)} options={[{ label: '7 天', value: 7 }, { label: '30 天', value: 30 }, { label: '90 天', value: 90 }]} />}>
    {detail === undefined ? null : <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
      <Row gutter={[12, 12]} className="trajectoryMetrics" style={{ borderRadius: 14 }}>
        <div><span>提交数</span><strong>{s?.commits ?? 0}</strong><small>近 {days} 天</small></div>
        <div><span>活跃开发者</span><strong>{s?.activeDevelopers ?? 0}</strong><small>按 Git 作者</small></div>
        <div><span>活跃天数</span><strong>{s?.activeDays ?? 0}</strong><small>有提交的天数</small></div>
        <div><span>代码增删</span><strong>+{s?.insertions ?? 0} / -{s?.deletions ?? 0}</strong><small>近 {days} 天</small></div>
        <div><span>最后提交</span><strong>{(s?.lastCommitAt ?? 0) === 0 ? '—' : new Date(s?.lastCommitAt ?? 0).toLocaleDateString()}</strong><small>{s === undefined ? '' : `${(s.topChangedFiles ?? 0)} 个变更文件`}</small></div>
      </Row>
      <Card size="small" title="提交趋势">{loading ? <Card loading /> : data?.trend.length === 0 ? <Empty description="该时间段内没有提交" /> : <div className="chart-trend" style={{ height: 130 }}>{data?.trend.map(item => <div key={item.day} className="trendGroup"><div className="trendBars"><div className={item.commits === 0 ? 'bar tool empty' : 'bar tool'} style={{ height: `${Math.max(3, Math.round(item.commits / trendMax * 100))}%` }}><span className="v">{item.commits}</span></div></div><span className="d">{item.day.slice(5)}</span></div>)}</div>}</Card>
      <Row gutter={[12, 12]}>
        <Col xs={24} xl={12}><Card size="small" title="作者分布"><Table rowKey="authorEmail" size="small" columns={authorColumns} dataSource={data?.authors ?? []} pagination={false} locale={{ emptyText: '暂无作者数据' }} /></Card></Col>
        <Col xs={24} xl={12}><Card size="small" title="提交类型分布">{typeTotal === 0 ? <Empty description="暂无提交" /> : <><Space wrap style={{ marginBottom: 10 }}>{(data?.commitTypes ?? []).map(item => { const meta = COMMIT_TYPE_META[item.type] ?? COMMIT_TYPE_META['other']!; return <Tag key={item.type} color={meta.color}>{meta.label} {item.count}</Tag> })}</Space><HBarChart rows={(data?.commitTypes ?? []).map(item => ({ label: (COMMIT_TYPE_META[item.type] ?? COMMIT_TYPE_META['other']!).label, value: item.count, display: `${Math.round(item.count / typeTotal * 100)}%` }))} /></>}</Card></Col>
      </Row>
      <Row gutter={[12, 12]}>
        <Col xs={24} xl={10}><Card size="small" title="高频变更目录"><HBarChart color="green" rows={(data?.hotDirectories ?? []).map(item => ({ label: item.directory, value: item.count, display: `${item.count} 个文件` }))} /></Card></Col>
        <Col xs={24} xl={14}><Card size="small" title="最近提交" extra={<Typography.Text type="secondary">Git 作者归属优先，未绑定显示 Git 名</Typography.Text>}><Table rowKey="commitHash" size="small" columns={commitColumns} dataSource={data?.commits ?? []} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 900 }} /></Card></Col>
      </Row>
    </Space>}
  </Drawer>
}

/** 用户详情抽屉：参与项目/研发活动/AI 用量/Agent 用量。 */
function UserDetailDrawer({ detail, onClose }: { detail: UserDetailRef | undefined; onClose: () => void }) {
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const [data, setData] = useState<UserDetail>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (detail === undefined) return
    let live = true
    setError('')
    void fetch(`/team/admin/user-detail/${encodeURIComponent(detail.userId)}?days=${days}`).then(async response => {
      const body = await response.json() as UserDetail & { message?: string }
      if (!response.ok) throw new Error(body.message ?? '加载用户详情失败')
      if (live) setData(body)
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '加载用户详情失败') })
    return () => { live = false }
  }, [detail, days])
  const s = data?.summary
  const commitColumns: ColumnsType<UserDetail['commits'][number]> = [
    { title: '提交', width: 90, render: (_, commit) => <Typography.Text code copyable>{commit.commitHash.slice(0, 8)}</Typography.Text> },
    { title: '项目', width: 200, render: (_, commit) => commit.gitRemote === undefined ? <Tag>本地仓库</Tag> : <Typography.Text ellipsis={{ tooltip: commit.gitRemote }} style={{ maxWidth: 190, display: 'inline-block' }}>{commit.gitRemote.split('/').at(-1)?.replace(/\.git$/, '')}</Typography.Text> },
    { title: '说明', render: (_, commit) => commit.subject ?? commit.message ?? '—' },
    { title: '类型', width: 90, render: (_, commit) => { const meta = COMMIT_TYPE_META[commit.type] ?? COMMIT_TYPE_META['other']!; return <Tag color={meta.color}>{meta.label}</Tag> } },
    { title: '增删', width: 120, render: (_, commit) => <span><Typography.Text type="success">+{commit.insertions}</Typography.Text> <Typography.Text type="danger">-{commit.deletions}</Typography.Text></span> },
    { title: '时间', width: 170, dataIndex: 'time', render: value => new Date(value).toLocaleString() },
  ]
  const sessionColumns: ColumnsType<UserDetail['recentSessions'][number]> = [
    { title: '会话', render: (_, session) => session.title },
    { title: '项目', width: 200, render: (_, session) => session.gitRemote === undefined ? <Tag>未关联</Tag> : <Typography.Text ellipsis={{ tooltip: session.gitRemote }} style={{ maxWidth: 190, display: 'inline-block' }}>{session.gitRemote.split('/').at(-1)?.replace(/\.git$/, '')}</Typography.Text> },
    { title: '工具', dataIndex: 'toolCalls', width: 80 },
    { title: '失败', dataIndex: 'toolFailures', width: 70, render: value => value === 0 ? '—' : <Tag color="red">{value}</Tag> },
    { title: '最后活跃', width: 170, dataIndex: 'lastActiveAt', render: value => new Date(value).toLocaleString() },
  ]
  return <Drawer width={Math.min(1180, window.innerWidth)} open={detail !== undefined} onClose={onClose} className="trajectoryDrawer" title={detail === undefined ? '' : <span>{data?.userName ?? detail.userName} <Typography.Text type="secondary">用户详情</Typography.Text></span>} extra={<Segmented value={days} onChange={value => setDays(value as 7 | 30 | 90)} options={[{ label: '7 天', value: 7 }, { label: '30 天', value: 30 }, { label: '90 天', value: 90 }]} />}>
    {detail === undefined ? null : <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
      <Row gutter={[12, 12]} className="trajectoryMetrics" style={{ borderRadius: 14 }}>
        <div><span>研发提交</span><strong>{s?.commits ?? 0}</strong><small>近 {days} 天</small></div>
        <div><span>代码增删</span><strong>+{s?.insertions ?? 0} / -{s?.deletions ?? 0}</strong><small>近 {days} 天</small></div>
        <div><span>参与项目</span><strong>{s?.activeProjects ?? 0}</strong><small>有提交的项目</small></div>
        <div><span>Session</span><strong>{s?.sessions ?? 0}</strong><small>{s === undefined ? '' : `${s.toolCalls} 次工具调用 · ${s.toolFailures} 次失败`}</small></div>
        <div><span>AI 成本</span><strong>{fmtCny(s?.costCny ?? 0)}</strong><small>{s === undefined ? '' : `${fmtNum(s.totalTokens)} Token · ${s.modelRequests} 请求`}</small></div>
      </Row>
      <Row gutter={[12, 12]}>
        <Col xs={24} xl={10}><Card size="small" title="参与项目"><Table rowKey="gitRemote" size="small" pagination={false} dataSource={data?.projects ?? []} locale={{ emptyText: '统计范围内无提交' }} columns={[{ title: '项目', render: (_, project) => <div><Typography.Text strong>{project.projectName}</Typography.Text>{project.hasSessions && <Tag color="blue" style={{ marginLeft: 6 }}>有 Session</Tag>}<Typography.Text code copyable type="secondary" className="blockText">{project.gitRemote}</Typography.Text></div> }, { title: '提交', dataIndex: 'commits', width: 80 }]} /></Card></Col>
        <Col xs={24} xl={14}><Card size="small" title="AI 用量（网关记录）"><Table rowKey="model" size="small" pagination={false} dataSource={data?.models ?? []} locale={{ emptyText: '统计范围内无模型请求' }} columns={[{ title: '模型', dataIndex: 'model', ellipsis: true }, { title: '请求', dataIndex: 'requests', width: 80 }, { title: '总 Token', width: 110, render: (_, model) => fmtNum(model.inputTokens + model.outputTokens) }, { title: '成本', width: 100, dataIndex: 'costCny', render: fmtCny }]} /></Card></Col>
      </Row>
      <Card size="small" title="最近提交"><Table rowKey="commitHash" size="small" columns={commitColumns} dataSource={data?.commits ?? []} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 900 }} /></Card>
      <Card size="small" title="最近 Session"><Table rowKey="sessionId" size="small" columns={sessionColumns} dataSource={data?.recentSessions ?? []} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 800 }} /></Card>
    </Space>}
  </Drawer>
}

function useOverview(days: 1 | 7 | 30): { data?: Overview; loading: boolean; error: string } {
  const [data, setData] = useState<Overview>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    void fetch(`/team/admin/overview?days=${days}`).then(async response => {
      const body = await response.json() as Overview & { message?: string }
      if (!response.ok) throw new Error(body.message ?? '加载数据失败')
      if (live) setData(body)
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '加载数据失败') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [days])
  return { ...(data === undefined ? {} : { data }), loading, error }
}

function DimensionToolbar({ days, onChange }: { days: 1 | 7 | 30; onChange: (days: 1 | 7 | 30) => void }) {
  return <div className="dimensionToolbar"><Typography.Text type="secondary">AI 使用与 Git 提交按用户或远程仓库独立汇总，不推断 Session 与提交的归属关系</Typography.Text><Segmented value={days} onChange={value => onChange(value as 1 | 7 | 30)} options={[{ label: '24 小时', value: 1 }, { label: '7 天', value: 7 }, { label: '30 天', value: 30 }]} /></div>
}

function DimensionSessions({ sessions, onOpenSession }: { sessions: OverviewRecent[]; onOpenSession: (d: SessionDetail) => void }) {
  const columns: ColumnsType<OverviewRecent> = [
    { title: '会话', render: (_, session) => <div className="recentSessionTitle"><Typography.Text strong ellipsis={{ tooltip: session.title }}>{session.title}</Typography.Text><Typography.Text code copyable type="secondary">{session.sessionId}</Typography.Text></div> },
    { title: '成员', dataIndex: 'userName', width: 130 },
    { title: '模型', width: 230, render: (_, session) => <SessionModels models={session.models ?? []} /> },
    { title: '工具', dataIndex: 'toolCalls', width: 70 },
    { title: '时长', width: 90, render: (_, session) => fmt(session.durationMs) },
    { title: '最后活跃', dataIndex: 'lastActiveAt', width: 180, render: value => new Date(value).toLocaleString() },
    { title: '错误', dataIndex: 'errorCount', width: 70, render: value => value === 0 ? '—' : <Tag color="red">{value}</Tag> },
    { title: '操作', width: 80, render: (_, session) => <Button type="link" onClick={() => void openDetail(session.sessionId, onOpenSession)}>分析</Button> },
  ]
  return <Table rowKey="sessionId" size="small" columns={columns} dataSource={sessions} pagination={false} scroll={{ x: 1130 }} />
}

function DimensionDetail({
  models,
  tools,
  commits,
  sessions,
  onOpenSession,
}: {
  models: OverviewModel[]
  tools: Omit<OverviewTool, 'users'>[]
  commits: OverviewCommit[]
  sessions: OverviewRecent[]
  onOpenSession: (detail: SessionDetail) => void
}) {
  const modelColumns: ColumnsType<OverviewModel> = [
    { title: '模型', dataIndex: 'model' },
    { title: '请求', dataIndex: 'requests', width: 80 },
    { title: '输入 Token', dataIndex: 'inputTokens', width: 110, render: fmtNum },
    { title: '输出 Token', dataIndex: 'outputTokens', width: 110, render: fmtNum },
    { title: '总 Token', dataIndex: 'totalTokens', width: 110, render: fmtNum },
  ]
  const toolColumns: ColumnsType<Omit<OverviewTool, 'users'>> = [
    { title: '工具', dataIndex: 'name' },
    { title: '调用', dataIndex: 'calls', width: 80 },
    { title: '失败', dataIndex: 'failures', width: 80, render: value => value === 0 ? '—' : <Tag color="red">{value}</Tag> },
  ]
  const commitColumns: ColumnsType<OverviewCommit> = [
    { title: '提交', render: (_, commit) => <div><Typography.Text strong>{commit.subject ?? '未记录提交说明'}</Typography.Text><Typography.Text code copyable type="secondary" className="blockText">{commit.commitHash.slice(0, 12)}</Typography.Text></div> },
    { title: '成员', dataIndex: 'userName', width: 120 },
    { title: '文件', dataIndex: 'files', width: 70 },
    { title: '代码增删', width: 120, render: (_, commit) => <span><Typography.Text type="success">+{commit.insertions}</Typography.Text> <Typography.Text type="danger">-{commit.deletions}</Typography.Text></span> },
    { title: '时间', dataIndex: 'time', width: 180, render: value => new Date(value).toLocaleString() },
  ]
  return <Space direction="vertical" size={14} style={{ width: '100%' }}>
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={12}><Card size="small" title="模型使用"><Table rowKey="model" size="small" columns={modelColumns} dataSource={models} pagination={false} /></Card></Col>
      <Col xs={24} xl={12}><Card size="small" title="工具使用"><Table rowKey="name" size="small" columns={toolColumns} dataSource={tools} pagination={false} /></Card></Col>
    </Row>
    <Card size="small" title="Git 提交"><Table rowKey="commitHash" size="small" columns={commitColumns} dataSource={commits} locale={{ emptyText: '统计范围内没有提交记录' }} pagination={{ pageSize: 8, showSizeChanger: false }} /></Card>
    <Card size="small" title="Session"><DimensionSessions sessions={sessions} onOpenSession={onOpenSession} /></Card>
  </Space>
}

function UserDataPanel({ onOpenSession }: { onOpenSession: (d: SessionDetail) => void }) {
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const { data, loading, error } = useOverview(days)
  const [userDetail, setUserDetail] = useState<UserDetailRef>()
  const columns: ColumnsType<OverviewUser> = [
    { title: '用户', render: (_, user) => <Space><Avatar shape="square">{user.userName.slice(0, 1)}</Avatar><div><Typography.Text strong>{user.userName}</Typography.Text><Typography.Text type="secondary" className="blockText">{user.userId}</Typography.Text></div></Space> },
    { title: '项目', dataIndex: 'projects', width: 75 },
    { title: '会话', dataIndex: 'sessions', width: 75 },
    { title: '提交', width: 75, render: (_, user) => user.commits.length || '—' },
    { title: '代码增删', width: 120, render: (_, user) => user.commits.length === 0 ? '—' : <span><Typography.Text type="success">+{user.insertions}</Typography.Text> <Typography.Text type="danger">-{user.deletions}</Typography.Text></span> },
    { title: '消息', dataIndex: 'messages', width: 75 },
    { title: '模型请求', dataIndex: 'modelRequests', width: 100 },
    { title: 'Token', dataIndex: 'totalTokens', width: 110, render: fmtNum },
    { title: '工具成功率', width: 110, render: (_, user) => user.toolCalls === 0 ? '—' : `${Math.round((user.toolCalls - user.toolFailures) / user.toolCalls * 1000) / 10}%` },
    { title: '活跃时长', width: 100, render: (_, user) => fmt(user.durationMs) },
    { title: '最后活跃', dataIndex: 'lastActiveAt', width: 180, render: value => value === 0 ? '—' : new Date(value).toLocaleString() },
    { title: '操作', width: 90, render: (_, user) => <Button type="link" onClick={() => setUserDetail({ userId: user.userId, userName: user.userName })}>详情</Button> },
  ]
  const totalTokens = data?.users.reduce((sum, user) => sum + user.totalTokens, 0) ?? 0
  return <Space direction="vertical" size={18} className="analyticsPage"><DimensionToolbar days={days} onChange={setDays} />{error && <Alert type="error" showIcon message={error} />}
    <Row gutter={[16, 16]} className="analyticsStats"><Col xs={12} lg={6}><Card loading={loading}><Statistic title="活跃用户" value={data?.users.length ?? 0} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="用户会话" value={data?.users.reduce((sum, user) => sum + user.sessions, 0) ?? 0} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="模型请求" value={data?.users.reduce((sum, user) => sum + user.modelRequests, 0) ?? 0} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="Token" value={fmtNum(totalTokens)} /></Card></Col></Row>
    <Card title="用户使用情况" className="analyticsCard"><Table rowKey="userId" loading={loading} columns={columns} dataSource={data?.users ?? []} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 1350 }} expandable={{ expandedRowRender: user => <DimensionDetail models={user.models} tools={user.tools} commits={user.commits} sessions={(data?.recentSessions ?? []).filter(session => session.userId === user.userId)} onOpenSession={onOpenSession} /> }} /></Card>
    <UserDetailDrawer detail={userDetail} onClose={() => setUserDetail(undefined)} />
  </Space>
}

function ProjectDataPanel({ onOpenSession }: { onOpenSession: (d: SessionDetail) => void }) {
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const { data, loading, error } = useOverview(days)
  const [projectDetail, setProjectDetail] = useState<ProjectDetailRef>()
  const columns: ColumnsType<OverviewDirectory> = [
    { title: '项目', render: (_, project) => <div><Typography.Text strong>{project.name}</Typography.Text><Typography.Text code copyable={{ text: project.gitRemote }} type="secondary" className="blockText analyticsPath">{project.gitRemote}</Typography.Text></div> },
    { title: '成员', dataIndex: 'users', width: 75 },
    { title: '会话', dataIndex: 'sessions', width: 75 },
    { title: '提交', width: 70, render: (_, project) => project.commits.length || '—' },
    { title: '代码增删', width: 120, render: (_, project) => project.commits.length === 0 ? '—' : <span><Typography.Text type="success">+{project.insertions}</Typography.Text> <Typography.Text type="danger">-{project.deletions}</Typography.Text></span> },
    { title: '消息', dataIndex: 'messages', width: 75 },
    { title: '模型请求', dataIndex: 'modelRequests', width: 100 },
    { title: 'Token', dataIndex: 'totalTokens', width: 110, render: fmtNum },
    { title: '工具调用', dataIndex: 'toolCalls', width: 100 },
    { title: '活跃时长', width: 100, render: (_, project) => fmt(project.durationMs) },
    { title: '错误', dataIndex: 'errors', width: 70, render: value => value === 0 ? '—' : <Tag color="red">{value}</Tag> },
    { title: '最后活跃', dataIndex: 'lastActiveAt', width: 180, render: value => new Date(value).toLocaleString() },
    { title: '操作', width: 90, render: (_, project) => <Button type="link" onClick={() => setProjectDetail({ gitRemote: project.gitRemote, projectName: project.name })}>详情</Button> },
  ]
  const activeMembers = new Set((data?.directories ?? []).flatMap(project => project.members.map(member => member.userId))).size
  return <Space direction="vertical" size={18} className="analyticsPage"><DimensionToolbar days={days} onChange={setDays} />{error && <Alert type="error" showIcon message={error} />}
    <Row gutter={[16, 16]} className="analyticsStats"><Col xs={12} lg={6}><Card loading={loading}><Statistic title="活跃项目" value={data?.directories.length ?? 0} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="参与成员" value={activeMembers} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="项目会话" value={data?.directories.reduce((sum, project) => sum + project.sessions, 0) ?? 0} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="Token" value={fmtNum(data?.directories.reduce((sum, project) => sum + project.totalTokens, 0) ?? 0)} /></Card></Col></Row>
    <Card title="Git 项目使用情况" className="analyticsCard"><Table rowKey="id" loading={loading} columns={columns} dataSource={data?.directories ?? []} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 1450 }} expandable={{ expandedRowRender: project => <Space direction="vertical" size={14} style={{ width: '100%' }}><Space wrap><Typography.Text type="secondary">参与成员</Typography.Text>{project.members.map(member => <Tag key={member.userId}>{member.userName}</Tag>)}</Space><DimensionDetail models={project.models} tools={project.tools} commits={project.commits} sessions={(data?.recentSessions ?? []).filter(session => session.gitRemote === project.id)} onOpenSession={onOpenSession} /></Space> }} /></Card>
    <ProjectDetailDrawer detail={projectDetail} onClose={() => setProjectDetail(undefined)} />
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
    { title: '会话', render: (_, session) => <div>{session.title !== undefined && <div><Typography.Text strong>{session.title}</Typography.Text></div>}<div><Typography.Text code copyable type="secondary">{session.sessionId}</Typography.Text></div></div> },
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

type GitEmailBinding = { email: string; userId: string; userName: string }

/** Git 邮箱 → 平台用户映射：用于 Commit 作者归属（Git 作者而非上传者）。 */
function GitEmailsPanel() {
  const [bindings, setBindings] = useState<GitEmailBinding[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [userId, setUserId] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [toast, contextHolder] = message.useMessage()
  const load = async (): Promise<void> => {
    setLoading(true); setError('')
    try {
      const [bindingResponse, userResponse] = await Promise.all([fetch('/team/admin/git-emails'), fetch('/team/admin/users')])
      const bindingData = await bindingResponse.json() as { bindings?: GitEmailBinding[]; message?: string }
      const userData = await userResponse.json() as { users?: User[]; message?: string }
      if (!bindingResponse.ok || bindingData.bindings === undefined) throw new Error(bindingData.message ?? '加载 Git 映射失败')
      if (!userResponse.ok || userData.users === undefined) throw new Error(userData.message ?? '加载用户失败')
      setBindings(bindingData.bindings)
      setUsers(userData.users.filter(user => user.status === 'active'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载失败')
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const bind = async (): Promise<void> => {
    const target = email.trim().toLowerCase()
    if (target === '' || userId === undefined) return
    setSaving(true)
    try {
      const response = await fetch('/team/admin/git-emails', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: target, userId }) })
      const body = await response.json() as { ok?: boolean; message?: string }
      if (!response.ok || body.ok !== true) throw new Error(body.message ?? '绑定失败')
      setEmail(''); setUserId(undefined)
      void toast.success('绑定成功'); await load()
    } catch (reason) {
      void toast.error(reason instanceof Error ? reason.message : '绑定失败')
    } finally { setSaving(false) }
  }
  const unbind = async (binding: GitEmailBinding): Promise<void> => {
    try {
      const response = await fetch(`/team/admin/git-emails/${encodeURIComponent(binding.email)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('解绑失败')
      void toast.success('已解绑'); await load()
    } catch (reason) {
      void toast.error(reason instanceof Error ? reason.message : '解绑失败')
    }
  }
  const columns: ColumnsType<GitEmailBinding> = [
    { title: 'Git 邮箱', dataIndex: 'email', render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: '平台用户', render: (_, binding) => <Space><Avatar shape="square" size="small">{binding.userName.slice(0, 1)}</Avatar><Typography.Text strong>{binding.userName}</Typography.Text><Typography.Text type="secondary">{binding.userId}</Typography.Text></Space> },
    { title: '操作', width: 100, render: (_, binding) => <Button type="link" danger onClick={() => void unbind(binding)}>解绑</Button> },
  ]
  return <>{contextHolder}<Card className="tableCard" title="Git 邮箱映射" extra={<Typography.Text type="secondary">Commit 作者邮箱 → 平台用户（作者归属）</Typography.Text>}>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} style={{ marginBottom: 12 }} />}
    <Space style={{ marginBottom: 16 }} wrap>
      <Input placeholder="Git 作者邮箱（如 liu@corp.com）" value={email} onChange={event => setEmail(event.target.value)} style={{ width: 260 }} />
      <Select placeholder="绑定到平台用户" value={userId} onChange={setUserId} style={{ width: 200 }} options={users.map(user => ({ value: user.id, label: `${user.name}（${user.id}）` }))} showSearch optionFilterProp="label" />
      <Button type="primary" loading={saving} disabled={email.trim() === '' || userId === undefined} onClick={() => void bind()}>绑定</Button>
    </Space>
    <Table rowKey="email" loading={loading} size="middle" columns={columns} dataSource={bindings} pagination={false} locale={{ emptyText: <Empty description="暂无 Git 邮箱映射；后台可手动绑定作者归属" /> }} />
  </Card></>
}

function SessionOwnershipPanel({ sessions, loading, onOpenSession }: { sessions: SessionOwner[]; loading: boolean; onOpenSession: (d: SessionDetail) => void }) {
  const groups = Object.values(sessions.reduce<Record<string, { userId: string; userName: string; email?: string; sessions: SessionOwner[] }>>((all, session) => { const group = all[session.userId] ?? { userId: session.userId, userName: session.userName, ...(session.email ? { email: session.email } : {}), sessions: [] }; group.sessions.push(session); all[session.userId] = group; return all }, {}))
  const columns: ColumnsType<SessionOwner> = [
    { title: '会话', dataIndex: 'title', render: (_, session) => <div><Typography.Text strong>{session.title ?? '会话记录不可用'}</Typography.Text><div><Typography.Text code copyable type="secondary">{session.sessionId}</Typography.Text></div></div> },
    { title: '更新时间', dataIndex: 'updatedAt', width: 190, render: (_, session) => session.updatedAt === undefined ? '—' : new Date(session.updatedAt).toLocaleString() },
    { title: '操作', width: 90, render: (_, session) => <Button type="link" onClick={() => void openDetail(session.sessionId, onOpenSession)}>分析</Button> },
  ]
  return <><Row gutter={16} className="stats"><Col span={8}><Card><Statistic title="已关联用户" value={groups.length} /></Card></Col><Col span={8}><Card><Statistic title="全部 Session" value={sessions.length} /></Card></Col><Col span={8}><Card><Statistic title="平均每人" value={groups.length ? (sessions.length / groups.length).toFixed(1) : 0} /></Card></Col></Row><Card className="sessionCard" loading={loading}>{groups.length === 0 ? <Empty description="暂无会话归属记录" /> : <Collapse defaultActiveKey={groups.map(group => group.userId)} items={groups.map(group => {
    const projects = Object.values(group.sessions.reduce<Record<string, { projectName?: string; gitRemote?: string; sessions: SessionOwner[] }>>((all, session) => {
      const key = session.gitRemote ?? '__unlinked__'
      const project = all[key] ?? { ...(session.projectName === undefined ? {} : { projectName: session.projectName }), ...(session.gitRemote === undefined ? {} : { gitRemote: session.gitRemote }), sessions: [] }
      project.sessions.push(session); all[key] = project; return all
    }, {}))
    return { key: group.userId, label: <div className="userGroupLabel"><Space><Avatar shape="square">{group.userName.slice(0, 1)}</Avatar><div><Typography.Text strong>{group.userName}</Typography.Text><Typography.Text type="secondary" className="blockText">{group.email ?? group.userId}</Typography.Text></div></Space><Tag color="blue">{group.sessions.length} 个 Session</Tag></div>, children: <Collapse className="directoryGroups" defaultActiveKey={projects.map(project => project.gitRemote ?? '__unlinked__')} items={projects.map(project => ({ key: project.gitRemote ?? '__unlinked__', label: <div className="directoryLabel"><div><Typography.Text strong>{project.projectName ?? '未关联 Git 项目'}</Typography.Text>{project.gitRemote !== undefined && <Typography.Text copyable type="secondary" className="directoryPath">{project.gitRemote}</Typography.Text>}</div><Tag>{project.sessions.length} 个会话</Tag></div>, children: <Table rowKey="sessionId" size="middle" columns={columns} dataSource={project.sessions} pagination={false} /> }))} /> }
  })} />}</Card></>
}

function Centered({ children }: { children: React.ReactNode }) { return <div className="centered">{children}</div> }
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{ token: { colorPrimary: '#1677ff', borderRadius: 10 }, components: { Layout: { siderBg: '#fff', headerBg: '#fff' }, Menu: { itemBorderRadius: 8 } } }}><AntApp><AdminRoot /></AntApp></ConfigProvider>)
