export const INTERNET_FILE_LIMIT = 1024 ** 3;

export function internetConfig(env = {}) {
  const positive = (name, fallback, max = Number.MAX_SAFE_INTEGER) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n <= 0 || n > max) throw Error(`Invalid ${name}`);
    return n;
  };
  const connectivityMode = env.PHONEHAUL_CONNECTIVITY_MODE ?? 'stun-only';
  if (!['stun-only', 'turn-enabled'].includes(connectivityMode))
    throw Error('Invalid PHONEHAUL_CONNECTIVITY_MODE');
  return {
    connectivityMode,
    trustedProxy: env.PHONEHAUL_TRUST_LOOPBACK_PROXY === '1',
    maxSessionMs: positive('PHONEHAUL_MAX_SESSION_MS', 24 * 60 * 60_000),
    maxFileBytes: positive(
      'PHONEHAUL_INTERNET_MAX_FILE_BYTES',
      INTERNET_FILE_LIMIT,
      64 * 1024 ** 3,
    ),
    invitationMs: positive('PHONEHAUL_INVITATION_MS', 15 * 60_000),
    recoveryMs: positive('PHONEHAUL_RECOVERY_MS', 10 * 60_000),
    maxRooms: positive('PHONEHAUL_MAX_ROOMS', 100),
    requestsPerMinute: positive('PHONEHAUL_REQUESTS_PER_MINUTE', 180),
  };
}
