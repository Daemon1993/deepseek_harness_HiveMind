import type { Context } from '@deepseek-ai/cordis'

import type {} from '../../team-platform/src/types.ts'

export const name = 'team-consumer'

export const inject = ['team']

export function apply(ctx: Context) {
  console.log('[team-consumer] loaded')
  // console.log('[team-consumer] team', ctx.team.getCurrentUserId())
}
