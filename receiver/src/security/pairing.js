import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import net from 'node:net';

export function localAddress(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isPrivateIPv4(entry.address)) continue;
      const physical = /^(wl|en|eth|wi-?fi|ethernet)/i.test(name);
      const virtual = /^(docker|veth|br-|virbr|tailscale|tun|tap|wg|zt|vmnet|vbox|podman)/i.test(
        name,
      );
      const linkLocal = entry.address.startsWith('169.254.');
      candidates.push({
        address: entry.address,
        score: (physical ? 100 : 0) - (virtual ? 100 : 0) - (linkLocal ? 50 : 0),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) return candidates[0].address;
  throw new Error('No private LAN IPv4 address found. Connect this computer to a local network.');
}

export function isPrivateIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function fingerprint(certPem) {
  const base64 = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

export class PairingSession {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.token = randomBytes(32).toString('base64url');
    this.expiresAt = now() + 5 * 60_000;
    this.connected = false;
  }
  valid(token) {
    if (typeof token !== 'string') return false;
    const a = Buffer.from(token);
    const b = Buffer.from(this.token);
    return (
      a.length === b.length &&
      timingSafeEqual(a, b) &&
      (this.connected || this.now() < this.expiresAt)
    );
  }
  expired() {
    return !this.connected && this.now() >= this.expiresAt;
  }
  connect(token) {
    if (!this.valid(token)) return false;
    this.connected = true;
    return true;
  }
  uri(host, port, certFingerprint) {
    return `phonehaul://pair?v=1&h=${encodeURIComponent(host)}&p=${port}&s=${encodeURIComponent(this.token)}&f=${certFingerprint}`;
  }
}
