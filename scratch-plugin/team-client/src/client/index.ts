import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AccountStatus } from './AccountStatus.tsx'
import { SyncStatusBanner } from './SyncStatusBanner.tsx'

export const inject = ['slots']

/** Register employee account status and the sync indicator in the sidebar footer slot. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'team-account', order: 100 },
    AccountStatus,
  ))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'team-sync-status', order: 90 },
    SyncStatusBanner,
  ))
}
