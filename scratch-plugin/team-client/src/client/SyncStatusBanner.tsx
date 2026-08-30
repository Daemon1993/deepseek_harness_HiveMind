import { useEffect, useRef, useState } from 'react'

type SyncStatusState = { syncing: boolean; lastSyncAt: number; lastSyncedSession?: string }

/** 每次同步/手动点击至少展示 2 秒的实时效果。 */
const MIN_DISPLAY_MS = 2000
const POLL_MS = 500

/** 侧边栏底部悬浮同步胶囊（不占布局）：显示同步状态 + 手动同步按钮。 */
export function SyncStatusBanner() {
  const [status, setStatus] = useState<SyncStatusState>({ syncing: false, lastSyncAt: 0 })
  const [showUntil, setShowUntil] = useState(0)
  const [doneUntil, setDoneUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const prevLastSyncAt = useRef(0)

  useEffect(() => {
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch('/team/sync/status', { credentials: 'same-origin', cache: 'no-store' })
        if (response.ok) {
          const state = await response.json() as SyncStatusState
          setStatus(state)
          const t = Date.now()
          if (state.syncing) {
            setShowUntil(t + MIN_DISPLAY_MS)
          } else if (state.lastSyncAt > prevLastSyncAt.current) {
            if (t >= showUntil) setDoneUntil(t + MIN_DISPLAY_MS)
            prevLastSyncAt.current = state.lastSyncAt
          }
          setNow(t)
        }
      } catch { /* Host 不可达 */ }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [showUntil])

  /** 手动同步：无论是否已有数据都触发，并强制展示 ≥2 秒同步动画。 */
  const manualSync = async (): Promise<void> => {
    setShowUntil(Date.now() + MIN_DISPLAY_MS)
    try {
      await fetch('/team/sync/now', { method: 'POST', credentials: 'same-origin' })
    } catch { /* Host 不可达：动画仍展示 */ }
  }

  const syncing = now < showUntil
  const done = !syncing && now < doneUntil
  const timeLabel = status.lastSyncAt > 0
    ? new Date(status.lastSyncAt).toLocaleTimeString()
    : ''

  return <div style={{
    position: 'fixed',
    bottom: 16,
    right: 16, // 右下角空白处悬浮
    zIndex: 999,
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '3px 9px',
    fontSize: 11, fontWeight: 600,
    borderRadius: 12,
    color: syncing ? '#7a5b00' : done ? '#389e0d' : '#6b7280',
    background: syncing ? '#fffbe6' : done ? '#f6ffed' : 'rgba(255,255,255,.92)',
    border: syncing ? '1px solid #ffe58f' : done ? '1px solid #b7eb8f' : '1px solid #e5e5e5',
    boxShadow: '0 2px 8px rgba(0,0,0,.10)',
  }}>
    <span style={{
      width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
      background: syncing ? '#faad14' : done ? '#52c41a' : '#d9d9d9',
      animation: syncing ? 'team-sync-pulse 1s ease-in-out infinite' : undefined,
    }} />
    <span>{syncing ? '同步中…' : done ? '已同步' : '数据同步'}</span>
    {timeLabel !== '' && <span style={{ fontWeight: 400 }}>{timeLabel}</span>}
    <button type="button" onClick={() => void manualSync()} style={{
      padding: '0 6px', fontSize: 10.5, cursor: 'pointer', flexShrink: 0,
      color: '#1677ff', background: '#fff', border: '1px solid #91caff', borderRadius: 8,
      lineHeight: '16px',
    }}>手动同步</button>
    <style>{`@keyframes team-sync-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }`}</style>
  </div>
}
