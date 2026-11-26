// Timers: the box lifecycle tick and the provider check (docs/CLOUD.md section 3). Milestone 6
// adds the credit grants and expiry.
import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
crons.interval('box lifecycle', { minutes: 1 }, internal.boxes.tick, {});
crons.interval('box reconcile', { minutes: 10 }, internal.boxes.reconcile, {});
// Credits (section 5): expiry daily, everyone's medians daily, yearly plans' monthly grants hourly.
crons.daily('credits expire', { hourUTC: 0, minuteUTC: 5 }, internal.billing.expire, {});
crons.daily('estimate medians', { hourUTC: 0, minuteUTC: 15 }, internal.billing.medians, {});
crons.interval('yearly plan grants', { hours: 1 }, internal.stripe.yearlyGrants, {});
// Deleting for good (privacy.ts): apps past their undo window, ended download links, signing keys
// past their grace period hourly; old build files daily.
crons.interval('privacy sweep', { hours: 1 }, internal.privacy.sweep, {});
crons.daily('old build files', { hourUTC: 0, minuteUTC: 25 }, internal.privacy.sweepBuilds, {});
// Sign-ups that never finished (an email code asked for, never used), a day after.
crons.daily('unfinished sign-ups', { hourUTC: 0, minuteUTC: 35 }, internal.privacy.sweepUnverified, {});
export default crons;
