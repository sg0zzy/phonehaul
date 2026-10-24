import { randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto';

const secret = () => randomBytes(32).toString('base64url');
const reject = (status, message) => {
  throw Object.assign(Error(message), { status });
};

export class Rooms {
  constructor(config, { now = Date.now } = {}) {
    this.config = config;
    this.now = now;
    this.rooms = new Map();
    this.codes = new Map();
  }
  sweep() {
    for (const [id, room] of this.rooms) {
      const peers = Object.values(room.peers);
      const lastSeen = Math.min(...peers.map((p) => p.lastSeen));
      const expired = !room.established && this.now() >= room.invitationExpires;
      // A polling gap is disconnection. An invitation timer never ends an
      // established session; only the separate recovery deadline does.
      if (
        expired ||
        this.now() - lastSeen > this.config.recoveryMs + 30_000 ||
        (room.disconnectedAt != null && this.now() - room.disconnectedAt >= this.config.recoveryMs)
      ) {
        this.rooms.delete(id);
        this.codes.delete(room.code);
      }
    }
  }
  create() {
    this.sweep();
    if (this.rooms.size >= this.config.maxRooms)
      reject(503, 'Session capacity is full. Try again later.');
    const id = randomBytes(16).toString('hex');
    let code;
    do {
      code = String(randomInt(0, 1_000_000_000_000)).padStart(12, '0');
    } while (this.codes.has(code));
    const token = secret();
    const room = {
      id,
      code,
      invitationExpires: this.now() + this.config.invitationMs,
      established: false,
      peers: { owner: this.peer(token) },
    };
    this.rooms.set(id, room);
    this.codes.set(code, id);
    return { id, code, token, role: 'owner', invitationExpires: room.invitationExpires };
  }
  peer(token) {
    return { token, lastSeen: this.now(), queue: [], approved: false };
  }
  join(code) {
    this.sweep();
    const room = this.rooms.get(this.codes.get(code) ?? code);
    if (!room || room.established || this.now() >= room.invitationExpires)
      reject(404, 'Invitation unavailable or expired.');
    if (room.peers.guest)
      reject(409, 'A peer is already waiting. Create a new invitation if this is unexpected.');
    const token = secret();
    room.peers.guest = this.peer(token);
    room.peers.owner.queue.push({ type: 'joined' });
    return {
      id: room.id,
      code: room.code,
      token,
      role: 'guest',
      invitationExpires: room.invitationExpires,
    };
  }
  authenticate(id, token) {
    this.sweep();
    const room = this.rooms.get(id);
    if (!room || typeof token !== 'string')
      reject(401, 'Session expired. Create or join a new session.');
    const role = Object.keys(room.peers).find((r) => {
      const expected = Buffer.from(room.peers[r].token),
        actual = Buffer.from(token);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    });
    if (!role) reject(401, 'Invalid session.');
    const peer = room.peers[role];
    peer.lastSeen = this.now();
    return { room, peer, role };
  }
  signal(id, token, message) {
    const { room, role } = this.authenticate(id, token);
    if (!message || !['offer', 'answer', 'restart', 'reject', 'close'].includes(message.type))
      reject(400, 'Invalid signaling message');
    if (
      ['offer', 'answer'].includes(message.type) &&
      (typeof message.sdp !== 'string' || message.sdp.length > 100_000)
    )
      reject(400, 'Invalid session description');
    if (
      (message.type === 'offer' && role !== 'owner') ||
      (message.type === 'answer' && role !== 'guest')
    )
      reject(403, 'Invalid signaling role');
    const other = room.peers[role === 'owner' ? 'guest' : 'owner'];
    if (!other) reject(409, 'Waiting for the other peer.');
    if (other.queue.length >= 16) reject(429, 'Peer is not accepting messages.');
    // Forward only the bounded signaling vocabulary, never arbitrary payloads.
    other.queue.push({
      type: message.type,
      ...(['offer', 'answer'].includes(message.type) ? { sdp: message.sdp } : {}),
    });
  }
  poll(id, token, connected = false) {
    const { room, peer } = this.authenticate(id, token);
    peer.connected = connected;
    if (room.established) {
      if (Object.values(room.peers).every((p) => p.connected)) room.disconnectedAt = null;
      else room.disconnectedAt ??= this.now();
    }
    return peer.queue.splice(0);
  }
  approve(id, token) {
    const { room, peer } = this.authenticate(id, token);
    peer.approved = true;
    peer.connected = true;
    room.established = Boolean(room.peers.owner.approved && room.peers.guest?.approved);
  }
  close(id, token) {
    const { room } = this.authenticate(id, token);
    this.rooms.delete(id);
    this.codes.delete(room.code);
  }
}

export function turnCredentials(
  { urls, secret: key, lifetimeSeconds = 3600 },
  identity,
  now = Date.now(),
) {
  if (!urls?.length || !key) return [];
  const username = `${Math.floor(now / 1000) + lifetimeSeconds}:${identity}`;
  return [
    { urls, username, credential: createHmac('sha1', key).update(username).digest('base64') },
  ];
}
