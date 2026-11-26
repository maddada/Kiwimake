// The uptime monitor's check (http.ts /health): one cheap database read, nothing about anyone.
import { internalQuery } from './_generated/server';

export const ping = internalQuery({
  args: {},
  handler: async (ctx) => {
    await ctx.db.query('meta').first();
    return { at: Date.now() };
  },
});
