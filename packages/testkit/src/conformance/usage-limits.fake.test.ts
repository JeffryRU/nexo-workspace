import { FakeUsageLimits } from '../fake-usage-limits.ts'
import { runUsageLimitsConformance } from './usage-limits.ts'

for (const queryable of [true, false]) {
  runUsageLimitsConformance(
    `FakeUsageLimits (${queryable ? 'consultable' : 'solo avisos'})`,
    () => {
      const limits = new FakeUsageLimits('fake', { queryable })
      return {
        limits,
        seed: async (windows) => limits.set(windows),
        report: async (windows) => limits.report(windows),
      }
    },
  )
}
