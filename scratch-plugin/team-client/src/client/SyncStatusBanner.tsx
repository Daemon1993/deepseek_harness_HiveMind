import { useEffect, useRef, useState } from 'react'

type SyncStatusState = { syncing: boolean; lastSyncAt: number; lastSyncedSession?: string }

/** 每次自动或手动同步至少展示 2 秒的实时效果。 */
const MIN_DISPLAY_MS = 2000
const POLL_MS = 500

/** 侧边栏底部悬浮同步胶囊（不占布局）：显示自动同步状态。 */
export function SyncStatusBanner() {
  const [status, setStatus] = useState<SyncStatusState>({ syncing: false, lastSyncAt: 0 })
  const [showUntil, setShowUntil] = useState(0)
  const [doneUntil, setDoneUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const previousSyncAt = useRef(0)

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
          } else if (state.lastSyncAt > previousSyncAt.current) {
            setDoneUntil(t + MIN_DISPLAY_MS)
            previousSyncAt.current = state.lastSyncAt
          }
          setNow(t)
        }
      } catch { /* Host 不可达 */ }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [])

  const manualSync = async (): Promise<void> => {
    setShowUntil(Date.now() + MIN_DISPLAY_MS)
    try {
      await fetch('/team/sync/now', { method: 'POST', credentials: 'same-origin' })
    } catch { /* Host 不可达，状态轮询会继续等待。 */ }
  }

  const syncing = now < showUntil
  const synced = !syncing && (now < doneUntil || status.lastSyncAt > 0)
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
    color: syncing ? '#7a5b00' : synced ? '#389e0d' : '#6b7280',
    background: syncing ? '#fffbe6' : synced ? '#f6ffed' : 'rgba(255,255,255,.92)',
    border: syncing ? '1px solid #ffe58f' : synced ? '1px solid #b7eb8f' : '1px solid #e5e5e5',
    boxShadow: '0 2px 8px rgba(0,0,0,.10)',
  }}>
    <span style={{
      width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
      background: syncing ? '#faad14' : synced ? '#52c41a' : '#d9d9d9',
      animation: syncing ? 'team-sync-pulse 1s ease-in-out infinite' : undefined,
    }} />
    <span>{syncing ? '同步中…' : synced ? '已同步' : '等待首次同步'}</span>
    {timeLabel !== '' && <span style={{ fontWeight: 400 }}>{timeLabel}</span>}
    <button type="button" onClick={() => void manualSync()} style={{
      padding: '0 6px', fontSize: 10.5, cursor: 'pointer', flexShrink: 0,
      color: '#1677ff', background: '#fff', border: '1px solid #91caff', borderRadius: 8,
      lineHeight: '16px',
    }}>手动同步</button>
    <style>{`@keyframes team-sync-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }`}</style>
  </div>
}
