// Reports from queries and mutations, which cannot fetch: they schedule this with what they
// caught (lib/errors.ts). Only what the report carries is sent, scrubbed again there.
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { sendReport } from './lib/errors';

export const report = internalAction({
  args: { where: v.string(), message: v.string(), type: v.optional(v.string()), stack: v.optional(v.string()), level: v.optional(v.union(v.literal('error'), v.literal('warning'))) },
  handler: async (_ctx, r) => {
    await sendReport(r);
  },
});
