import { startSignaling } from './signaling.js';
import { internetConfig } from './config.js';

const env = process.env;
const list = (key) =>
  (env[key] ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
const app = await startSignaling({
  host: env.PHONEHAUL_SIGNAL_HOST ?? '127.0.0.1',
  port: Number(env.PHONEHAUL_SIGNAL_PORT ?? 8787),
  config: internetConfig(env),
  allowedOrigins: list('PHONEHAUL_ALLOWED_ORIGINS'),
  stunUrls: list('PHONEHAUL_STUN_URLS'),
  turn: {
    urls: list('PHONEHAUL_TURN_URLS'),
    secret: env.PHONEHAUL_TURN_SECRET,
    maxSessions: Number(env.PHONEHAUL_TURN_MAX_SESSIONS ?? 0),
    lifetimeSeconds: Number(env.PHONEHAUL_TURN_CREDENTIAL_SECONDS ?? 3600),
  },
});
console.log(`PhoneHaul signaling ready: ${app.url}/internet/ (use HTTPS outside localhost)`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close());
