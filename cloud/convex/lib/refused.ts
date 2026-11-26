// Refusals written for the person, which production passes to the apps (see Refused).
import { ConvexError } from 'convex/values';

/**
 * A refusal written for the person (a full sentence they can act on). It is a ConvexError, so a
 * production deployment passes its text to the app as `error.data`; a plain Error's message is
 * hidden there ("Server Error") and is for us only (the logs and Sentry).
 */
export class Refused extends ConvexError<string> {
  constructor(message: string) {
    super(message);
  }
}
