/**
 * Simple in-memory per-host rate limiter.
 * Uses a sliding window of timestamps per host.
 * Configurable via env vars:
 *  - VIDEO_HOST_RATE_LIMIT_WINDOW_MS (default 60000)
 *  - VIDEO_HOST_RATE_LIMIT_MAX (default 6)
 */
const DEFAULT_WINDOW = Number(process.env.VIDEO_HOST_RATE_LIMIT_WINDOW_MS || 60000);
const DEFAULT_MAX = Number(process.env.VIDEO_HOST_RATE_LIMIT_MAX || 6);

const hosts = new Map();

function now() { return Date.now(); }

function purgeOld(entries, windowMs) {
  const cutoff = now() - windowMs;
  while (entries.length > 0 && entries[0] < cutoff) entries.shift();
}

async function waitForTurn(host) {
  if (!host) return;
  const windowMs = DEFAULT_WINDOW;
  const max = DEFAULT_MAX;
  if (!hosts.has(host)) hosts.set(host, []);
  const entries = hosts.get(host);

  purgeOld(entries, windowMs);
  if (entries.length < max) {
    entries.push(now());
    return;
  }

  // need to wait until the oldest entry expires
  const oldest = entries[0];
  const delay = Math.max(50, (oldest + windowMs) - now());
  // cap wait to 30s to avoid very long blocking
  const capped = Math.min(delay, 30000);
  await new Promise((resolve) => setTimeout(resolve, capped));
  // after waiting, record timestamp and proceed
  purgeOld(entries, windowMs);
  entries.push(now());
}

module.exports = { waitForTurn };
