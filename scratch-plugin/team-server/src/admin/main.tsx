import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, App as AntApp, Avatar, Badge, Button, Card, Col, Collapse, ConfigProvider, Drawer, Empty, Input, Layout, Menu, Popconfirm, Row, Segmented, Select, Space, Statistic, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'

type Role = 'admin' | 'developer' | 'reviewer' | 'user'
type Status = 'pending' | 'active' | 'rejected' | 'disabled'
type User = { id: string; email?: string; name: string; status: Status; role: Role; password?: string }
type SessionOwner = { sessionId: string; userId: string; userName: string; email?: string; createdAt: string; lastActiveAt: string; title?: string; projectName?: string; gitRemote?: string; updatedAt?: number; blank?: boolean }
type Phase = 'checking' | 'ready'
type Section = 'dashboard' | 'users' | 'projects' | 'sessions' | 'accounts' | 'sync'

// ── 总览类型（/team/admin/overview）──────────────────────────
type OverviewSummary = {
  sessions: number; activeUsers: number; projects: number
  userMessages: number; assistantMessages: number
  toolCalls: number; toolFailures: number; toolFailureRate: number
  modelRequests: number; inputTokens: number; outputTokens: number; totalTokens: number
  activeDurationMs: number; durationMs: number; errors: number
}
type OverviewTrend = { date: string; sessions: number; activeUsers: number; toolCalls: number; modelRequests: number; totalTokens: number }
type OverviewUser = { userId: string; userName: string; sessions: number; projects: number; messages: number; toolCalls: number; toolFailures: number; modelRequests: number; totalTokens: number; durationMs: number; errors: number; lastActiveAt: number }
type OverviewDirectory = { id: string; name: string; gitRemote: string; sessions: number; users: number; members: { userId: string; userName: string }[]; messages: number; toolCalls: number; toolFailures: number; modelRequests: number; totalTokens: number; durationMs: number; errors: number; lastActiveAt: number }
type OverviewTool = { name: string; calls: number; failures: number; users: number }
type OverviewModel = { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }
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
    : section === 'users'
      ? { title: '用户数据', description: '按成员查看项目参与、会话活动、AI 消耗与工具质量' }
    : section === 'projects'
      ? { title: '项目数据', description: '按 Git 远程仓库查看成员参与、会话产出、Token 与运行异常' }
    : section === 'accounts'
      ? { title: '账号与权限', description: '统一管理账号申请、用户状态和角色权限' }
    : section === 'sync'
      ? { title: '同步状态', description: '查看每位用户的 Session 同步进度与健康情况' }
      : { title: '会话', description: '按用户与项目查看全部会话，点击查看完整分析' }
  return <><Layout className="page">{contextHolder}<Layout.Sider width={240} theme="light" className="adminSider"><div className="brand"><div className="brandMark">AI</div><div><Typography.Text strong>TEAM PLATFORM</Typography.Text><Typography.Text type="secondary" className="blockText">管理控制台</Typography.Text></div></div><Menu mode="inline" selectedKeys={[section]} onSelect={({ key }) => { setSection(key as Section); document.getElementById('admin-main-scroll')?.scrollTo({ top: 0 }) }} items={[...(canEdit ? [{ key: 'dashboard', label: '总览' }, { key: 'users', label: '用户' }, { key: 'projects', label: '项目' }] : []), { key: 'accounts', label: '账号与权限' }, ...(canEdit ? [{ key: 'sessions', label: <Space>会话<Badge count={sessions.length} showZero color="#1677ff" /></Space> }, { key: 'sync', label: '同步状态' }] : [])]} /><div className="siderUser"><Avatar>{currentUser?.name.slice(0, 1)}</Avatar><div><Typography.Text strong>{currentUser?.name}</Typography.Text><Typography.Text type="secondary" className="blockText">{roleOptions.find(item => item.value === currentUser?.role)?.label}</Typography.Text></div></div></Layout.Sider><Layout id="admin-main-scroll" className="mainLayout"><Layout.Header className="topbar"><div><Typography.Title level={3}>{sectionCopy.title}</Typography.Title><Typography.Text type="secondary">{sectionCopy.description}</Typography.Text></div><Space><Button onClick={() => void logout()}>退出登录</Button></Space></Layout.Header><Layout.Content className="content">{section === 'dashboard' ? <DashboardPanel onOpenSession={setDetail} /> : section === 'users' ? <UserDataPanel onOpenSession={setDetail} /> : section === 'projects' ? <ProjectDataPanel onOpenSession={setDetail} /> : section === 'accounts' ? <AccountsPanel users={users} loading={loading} columns={columns} /> : section === 'sync' ? <SyncStatusPanel /> : <SessionOwnershipPanel sessions={sessions} loading={loading} onOpenSession={setDetail} />}</Layout.Content></Layout></Layout><SessionDetailDrawer detail={detail} onClose={() => setDetail(undefined)} /></>
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
    { label: '对话消息', value: String((s?.userMessages ?? 0) + (s?.assistantMessages ?? 0)), detail: `${s?.userMessages ?? 0} 用户 · ${s?.assistantMessages ?? 0} 助手` },
    { label: '平均请求消耗', value: fmtNum(avgTokens), detail: 'Token / 请求' },
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
  return { data, loading, error }
}

function DimensionToolbar({ days, onChange }: { days: 1 | 7 | 30; onChange: (days: 1 | 7 | 30) => void }) {
  return <div className="dimensionToolbar"><Typography.Text type="secondary">以下数据来自同步后写入 PostgreSQL 的 Session 分析快照</Typography.Text><Segmented value={days} onChange={value => onChange(value as 1 | 7 | 30)} options={[{ label: '24 小时', value: 1 }, { label: '7 天', value: 7 }, { label: '30 天', value: 30 }]} /></div>
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

function UserDataPanel({ onOpenSession }: { onOpenSession: (d: SessionDetail) => void }) {
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const { data, loading, error } = useOverview(days)
  const columns: ColumnsType<OverviewUser> = [
    { title: '用户', render: (_, user) => <Space><Avatar shape="square">{user.userName.slice(0, 1)}</Avatar><div><Typography.Text strong>{user.userName}</Typography.Text><Typography.Text type="secondary" className="blockText">{user.userId}</Typography.Text></div></Space> },
    { title: '项目', dataIndex: 'projects', width: 75 },
    { title: '会话', dataIndex: 'sessions', width: 75 },
    { title: '消息', dataIndex: 'messages', width: 75 },
    { title: '模型请求', dataIndex: 'modelRequests', width: 100 },
    { title: 'Token', dataIndex: 'totalTokens', width: 110, render: fmtNum },
    { title: '工具成功率', width: 110, render: (_, user) => user.toolCalls === 0 ? '—' : `${Math.round((user.toolCalls - user.toolFailures) / user.toolCalls * 1000) / 10}%` },
    { title: '活跃时长', width: 100, render: (_, user) => fmt(user.durationMs) },
    { title: '最后活跃', dataIndex: 'lastActiveAt', width: 180, render: value => value === 0 ? '—' : new Date(value).toLocaleString() },
  ]
  const totalTokens = data?.users.reduce((sum, user) => sum + user.totalTokens, 0) ?? 0
  return <Space direction="vertical" size={18} className="analyticsPage"><DimensionToolbar days={days} onChange={setDays} />{error && <Alert type="error" showIcon message={error} />}
    <Row gutter={[16, 16]} className="analyticsStats"><Col xs={12} lg={6}><Card loading={loading}><Statistic title="活跃用户" value={data?.users.length ?? 0} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="用户会话" value={data?.users.reduce((sum, user) => sum + user.sessions, 0) ?? 0} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="模型请求" value={data?.users.reduce((sum, user) => sum + user.modelRequests, 0) ?? 0} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="Token" value={fmtNum(totalTokens)} /></Card></Col></Row>
    <Card title="用户使用情况" className="analyticsCard"><Table rowKey="userId" loading={loading} columns={columns} dataSource={data?.users ?? []} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 1100 }} expandable={{ expandedRowRender: user => <DimensionSessions sessions={(data?.recentSessions ?? []).filter(session => session.userId === user.userId)} onOpenSession={onOpenSession} />, rowExpandable: user => (data?.recentSessions ?? []).some(session => session.userId === user.userId) }} /></Card>
  </Space>
}

function ProjectDataPanel({ onOpenSession }: { onOpenSession: (d: SessionDetail) => void }) {
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const { data, loading, error } = useOverview(days)
  const columns: ColumnsType<OverviewDirectory> = [
    { title: '项目', render: (_, project) => <div><Typography.Text strong>{project.name}</Typography.Text><Typography.Text code copyable={{ text: project.gitRemote }} type="secondary" className="blockText analyticsPath">{project.gitRemote}</Typography.Text></div> },
    { title: '成员', dataIndex: 'users', width: 75 },
    { title: '会话', dataIndex: 'sessions', width: 75 },
    { title: '提交', dataIndex: 'commits', width: 70, render: value => value === 0 ? '—' : value },
    { title: '代码增删', width: 120, render: (_, project) => project.commits === 0 ? '—' : <span><Typography.Text type="success">+{project.insertions}</Typography.Text> <Typography.Text type="danger">-{project.deletions}</Typography.Text></span> },
    { title: '消息', dataIndex: 'messages', width: 75 },
    { title: '模型请求', dataIndex: 'modelRequests', width: 100 },
    { title: 'Token', dataIndex: 'totalTokens', width: 110, render: fmtNum },
    { title: '工具调用', dataIndex: 'toolCalls', width: 100 },
    { title: '活跃时长', width: 100, render: (_, project) => fmt(project.durationMs) },
    { title: '错误', dataIndex: 'errors', width: 70, render: value => value === 0 ? '—' : <Tag color="red">{value}</Tag> },
    { title: '最后活跃', dataIndex: 'lastActiveAt', width: 180, render: value => new Date(value).toLocaleString() },
  ]
  const activeMembers = new Set((data?.directories ?? []).flatMap(project => project.members.map(member => member.userId))).size
  return <Space direction="vertical" size={18} className="analyticsPage"><DimensionToolbar days={days} onChange={setDays} />{error && <Alert type="error" showIcon message={error} />}
    <Row gutter={[16, 16]} className="analyticsStats"><Col xs={12} lg={6}><Card loading={loading}><Statistic title="活跃项目" value={data?.directories.length ?? 0} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="参与成员" value={activeMembers} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="项目会话" value={data?.directories.reduce((sum, project) => sum + project.sessions, 0) ?? 0} /></Card></Col><Col xs={12} lg={6}><Card loading={loading}><Statistic title="Token" value={fmtNum(data?.directories.reduce((sum, project) => sum + project.totalTokens, 0) ?? 0)} /></Card></Col></Row>
    <Card title="Git 项目使用情况" className="analyticsCard"><Table rowKey="id" loading={loading} columns={columns} dataSource={data?.directories ?? []} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 1100 }} expandable={{ expandedRowRender: project => <Space direction="vertical" size={14} style={{ width: '100%' }}><Space wrap><Typography.Text type="secondary">参与成员</Typography.Text>{project.members.map(member => <Tag key={member.userId}>{member.userName}</Tag>)}</Space><DimensionSessions sessions={(data?.recentSessions ?? []).filter(session => session.gitRemote === project.id)} onOpenSession={onOpenSession} /></Space>, rowExpandable: project => (data?.recentSessions ?? []).some(session => session.gitRemote === project.id) }} /></Card>
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
