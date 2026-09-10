// Retry policy for vTrack's local sync queue. Pure (no React, no Electron) so it
// can be reasoned about and tested on its own.
//
// The rule: a record stays on this device until the server confirms it. Nothing
// is ever given up on or deleted because a send failed.

export type Outcome = 'transient' | 'permanent'

// Delays between attempts for a failure that can clear up by itself: no network,
// a server hiccup, an expired login, a database change not applied yet. After the
// ramp it keeps trying every 30 minutes, forever.
const RAMP_MS = [15e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3]
const CEILING_MS = 30 * 60e3

// How long a record the server REJECTED waits before it's offered again. It is
// kept, never deleted, and retried occasionally in case whatever it depends on
// gets fixed.
export const QUARANTINE_RETRY_MS = 6 * 60 * 60e3

/** Delay before the next attempt, given how many attempts have already failed. */
export function backoffMs(failedAttempts: number, random: () => number = Math.random): number {
  // A missing or corrupt retry count starts the ramp instead of jumping to the ceiling.
  const i = Number.isFinite(failedAttempts) ? Math.max(0, Math.floor(failedAttempts)) : 0
  const base = i < RAMP_MS.length ? RAMP_MS[i] : CEILING_MS
  // ±20% jitter. The whole office shares one IP, so reconnecting in lockstep after
  // an outage would hit Supabase's rate limits all at once.
  return Math.round(base * (0.8 + 0.4 * random()))
}

// Postgres rejected the row itself: it points at something that doesn't exist, is
// missing a required value, or holds a malformed one. It will be rejected the same
// way every time until the data it depends on changes.
const PERMANENT_CODES = new Set(['23503', '23502', '23514', '22P02', '22007', '22008'])
const PERMANENT_TEXT = /violates foreign key|violates not-null|violates check|invalid input syntax/i

/**
 * Everything not recognisably permanent is transient, deliberately: network
 * failures, timeouts, 5xx, expired JWTs, RLS denials (a different account may be
 * signed in on this machine), and PGRST202 "function not found" (a migration not
 * applied yet). Guessing "permanent" wrongly would park a record for hours;
 * guessing "transient" wrongly only costs a few extra requests.
 */
export function classify(message: string, code?: string | null): Outcome {
  if (code && PERMANENT_CODES.has(code)) return 'permanent'
  return PERMANENT_TEXT.test(message || '') ? 'permanent' : 'transient'
}
