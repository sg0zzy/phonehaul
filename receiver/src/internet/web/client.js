import QRCode from 'qrcode';
import { DIRECT_UNAVAILABLE, checkIcePolicy, selectedTransport } from '../connectivity.js';
import { certificateFingerprint, verificationPhrase } from '../identity.js';
import { InternetTransfer } from '../transfer.js';
import { downloadSink, prepareDownloads } from './download.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const error = (e) => {
  $('error').textContent = e.message ?? String(e);
};
const status = (text) => {
  $('status').textContent = text;
};
let config,
  session,
  pc,
  channel,
  transfer,
  certificate,
  localApproved = false,
  remoteApproved = false;
let remoteHello,
  pinnedIdentity,
  currentIdentity,
  polling = false,
  recoveryDeadline = 0,
  offerDecision;
let attempt = 0;
let connectionTimer,
  diagnosticsTimer,
  connectionStarted,
  setupSeconds,
  connectivityMode,
  negotiating = false,
  starting = false;

function serviceUrl(raw) {
  const url = new URL(raw);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw Error(
      'Use the signaling service HTTPS origin (localhost HTTP is allowed for development).',
    );
  return url.origin;
}
async function request(path, { method = 'GET', body, authenticated = true } = {}) {
  const response = await fetch(`${session?.service ?? serviceUrl($('service').value)}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(authenticated && session ? { Authorization: `Bearer ${session.token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    signal: AbortSignal.timeout(25_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(Error(data.error ?? 'Service unavailable'), { status: response.status });
  return data;
}
const signal = (body) => request(`/v1/rooms/${session.id}/signal`, { method: 'POST', body });
async function updateReady() {
  if (!transfer) return;
  const active = pc;
  if (localApproved && remoteApproved && remoteHello) {
    try {
      await diagnostics(active);
    } catch (e) {
      error(e);
      active.close();
      interrupted();
      return;
    }
    if (pc !== active || active.connectionState === 'closed') return;
  }
  transfer.approved = Boolean(localApproved && remoteApproved && remoteHello);
  $('files').hidden = !transfer.approved;
  if (transfer.approved) {
    pinnedIdentity = currentIdentity;
    $('verification').hidden = true;
    status('Peer verified. Either device can send a copy.');
    recoveryDeadline = 0;
    $('retry').hidden = true;
    request(`/v1/rooms/${session.id}/approve`, { method: 'POST' }).catch(error);
  }
}
async function nativeCall(action, data) {
  if (config.mode === 'android') {
    const result = JSON.parse(window.PhoneHaulNative.call(action, JSON.stringify(data)));
    if (result.error) throw Error(result.error);
    return result;
  }
  const response = await fetch(
    `/api/internet/inbox${action === 'begin' ? '' : `/${data.id}/${action}`}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
async function makeSink(file) {
  if (config.mode === 'browser') return downloadSink(file);
  const opened = await nativeCall('begin', { ...file, limit: transfer.maxFileBytes });
  return {
    async write(chunk) {
      // Bounded chunks across either bridge; no whole-file base64 conversion.
      let text = '';
      for (const b of chunk) text += String.fromCharCode(b);
      await nativeCall('write', { id: opened.id, bytes: btoa(text) });
    },
    async finish(sha256) {
      return nativeCall('finish', { id: opened.id, sha256 });
    },
    async abort() {
      await nativeCall('abort', { id: opened.id });
    },
  };
}
function fileState(s) {
  if (['cancelled', 'failed'].includes(s.state)) {
    offerDecision?.(false);
    offerDecision = null;
    $('incoming').hidden = true;
  }
  $('progress-text').textContent =
    s.error ??
    `${s.name ?? ''} — ${s.state}${s.size == null ? '' : ` (${s.bytes}/${s.size} bytes)`}`;
  $('progress').value = s.size ? s.bytes / s.size : 0;
}
function interrupted() {
  if (!session) return;
  void transfer?.abort(Error('Connection interrupted. Retry from the beginning.'));
  transfer && (transfer.approved = false);
  offerDecision?.(false);
  offerDecision = null;
  $('incoming').hidden = true;
  $('files').hidden = true;
  recoveryDeadline ||= Date.now() + session.config.recoveryMs;
  $('retry').hidden = false;
  status(
    'Connection interrupted. Reconnect within the recovery window; interrupted files restart from byte zero.',
  );
}
function attach(dc) {
  if (
    dc.label !== 'phonehaul-v1' ||
    !dc.ordered ||
    dc.maxRetransmits != null ||
    dc.maxPacketLifeTime != null ||
    (channel && channel !== dc && channel.readyState !== 'closed')
  ) {
    dc.close();
    return;
  }
  channel = dc;
  channel.binaryType = 'arraybuffer';
  transfer = new InternetTransfer(channel, {
    maxFileBytes: Math.min(config.maxFileBytes, session.config.maxFileBytes),
    makeSink,
    onOffer: (file) =>
      new Promise((resolve) => {
        $('incoming-text').textContent = `Receive ${file.relativePath} (${file.size} bytes)?`;
        $('incoming').hidden = false;
        offerDecision = resolve;
      }),
    onState: fileState,
  });
  channel.onopen = () => {
    clearTimeout(connectionTimer);
    setupSeconds = Math.round((Date.now() - connectionStarted) / 1000);
    try {
      const local = certificateFingerprint(pc.localDescription.sdp);
      const remote = certificateFingerprint(pc.remoteDescription.sdp);
      const owner = session.role === 'owner' ? local : remote;
      const guest = session.role === 'owner' ? remote : local;
      currentIdentity = verificationPhrase(session.id, owner, guest);
      if (pinnedIdentity && pinnedIdentity !== currentIdentity)
        throw Error('Peer identity changed. End this session and pair again.');
      localApproved = Boolean(pinnedIdentity);
      remoteApproved = false;
      remoteHello = null;
      $('phrase').textContent = currentIdentity;
      $('approve').disabled = false;
      $('verification').hidden = Boolean(pinnedIdentity);
      channel.send(
        JSON.stringify({
          type: 'hello',
          version: 1,
          maxFileBytes: Math.min(config.maxFileBytes, session.config.maxFileBytes),
        }),
      );
      if (localApproved) channel.send(JSON.stringify({ type: 'approved' }));
      status('Connected securely. Compare the verification phrase before approving.');
    } catch (e) {
      error(e);
      channel.close();
    }
  };
  channel.onmessage = ({ data }) => {
    try {
      if (typeof data === 'string') {
        if (data.length > 8192) throw Error('Message too large');
        const m = JSON.parse(data);
        if (m.type === 'hello') {
          if (
            remoteHello ||
            m.version !== 1 ||
            !Number.isSafeInteger(m.maxFileBytes) ||
            m.maxFileBytes <= 0
          )
            throw Error('Invalid peer capabilities');
          remoteHello = m;
          transfer.maxFileBytes = Math.min(transfer.maxFileBytes, m.maxFileBytes);
          $('limit').textContent =
            `Internet limit: ${transfer.maxFileBytes} bytes per file, COPY only.`;
          updateReady();
          return;
        }
        if (m.type === 'approved') {
          remoteApproved = true;
          updateReady();
          return;
        }
      }
      if (!transfer.approved) throw Error('Unapproved peer attempted a file transfer');
      transfer.receive(data);
    } catch (e) {
      error(e);
      channel.close();
    }
  };
  channel.onclose = interrupted;
  channel.onerror = () => error(Error(DIRECT_UNAVAILABLE));
}
async function diagnostics(connection) {
  const selected = selectedTransport(await connection.getStats(), connectivityMode);
  if (pc !== connection) return;
  $('diagnostics').textContent =
    `ICE: ${connection.iceConnectionState}; ${selected ? `${selected.protocol} ${selected.local} ↔ ${selected.remote}` : 'candidate pair not reported'}; setup ${setupSeconds ?? Math.round((Date.now() - connectionStarted) / 1000)}s`;
  return selected;
}
async function makeConnection() {
  clearTimeout(connectionTimer);
  clearInterval(diagnosticsTimer);
  await transfer?.abort();
  if (transfer) transfer.approved = false;
  $('files').hidden = true;
  status('Establishing peer connection…');
  if (recoveryDeadline && Date.now() > recoveryDeadline)
    throw Error('Recovery window expired. Create a new session.');
  const previous = pc;
  if (previous) {
    previous.onconnectionstatechange = null;
    previous.close();
  }
  if (channel) {
    channel.onclose = null;
    channel.close();
  }
  localApproved = false;
  remoteApproved = false;
  remoteHello = null;
  const ice = await request(`/v1/rooms/${session.id}/ice`);
  connectivityMode = ice.connectivityMode;
  checkIcePolicy(connectivityMode, ice.iceServers);
  if ($('relay').checked && !ice.relayAvailable)
    throw Error(
      'TURN relay capacity is unavailable or exhausted. Retry later, or try a direct connection.',
    );
  certificate ??= await RTCPeerConnection.generateCertificate({
    name: 'ECDSA',
    namedCurve: 'P-256',
  });
  pc = new RTCPeerConnection({
    certificates: [certificate],
    iceServers: ice.iceServers,
    iceTransportPolicy: $('relay').checked ? 'relay' : 'all',
  });
  const connection = pc;
  connectionStarted = Date.now();
  setupSeconds = null;
  connectionTimer = setTimeout(() => {
    if (pc === connection && channel?.readyState !== 'open') {
      connection.close();
      interrupted();
      error(Error(DIRECT_UNAVAILABLE));
    }
  }, 60_000);
  diagnosticsTimer = setInterval(() => {
    if (pc === connection && connection.connectionState === 'connected')
      diagnostics(connection).catch((e) => {
        error(e);
        connection.close();
        interrupted();
      });
  }, 2000);
  pc.ondatachannel = (event) => attach(event.channel);
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) interrupted();
    if (pc.connectionState === 'failed') error(Error(DIRECT_UNAVAILABLE));
  };
}
async function gathered(description) {
  await pc.setLocalDescription(description);
  const connection = pc;
  await new Promise((resolve, reject) => {
    if (connection.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', check);
      reject(Error(DIRECT_UNAVAILABLE));
    }, 25_000);
    function check() {
      if (connection.iceGatheringState === 'complete') {
        clearTimeout(timer);
        connection.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    }
    connection.addEventListener('icegatheringstatechange', check);
  });
  checkIcePolicy(connectivityMode, [], connection.localDescription.sdp);
  return connection.localDescription.sdp;
}
async function offer() {
  if (negotiating) return;
  negotiating = true;
  try {
    await makeConnection();
    attach(pc.createDataChannel('phonehaul-v1', { ordered: true }));
    await signal({ type: 'offer', sdp: await gathered(await pc.createOffer()) });
  } finally {
    negotiating = false;
  }
}
async function poll() {
  if (polling) return;
  polling = true;
  const run = attempt;
  try {
    while (session && run === attempt) {
      try {
        const { events } = await request(
          `/v1/rooms/${session.id}/events?connected=${transfer?.approved && channel?.readyState === 'open' ? 1 : 0}`,
        );
        if (!session || run !== attempt) break;
        for (const m of events) {
          if (m.type === 'joined' && session.role === 'owner') await offer();
          else if (m.type === 'offer' && session.role === 'guest') {
            await makeConnection();
            checkIcePolicy(connectivityMode, [], m.sdp);
            await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
            await signal({ type: 'answer', sdp: await gathered(await pc.createAnswer()) });
          } else if (m.type === 'answer' && session.role === 'owner') {
            if (!pc || pc.signalingState === 'closed') continue;
            if (pc.signalingState !== 'have-local-offer')
              throw Error('Unexpected signaling answer');
            checkIcePolicy(connectivityMode, [], m.sdp);
            await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
          } else if (m.type === 'restart' && session.role === 'owner') await offer();
          else if (['reject', 'close'].includes(m.type))
            throw Object.assign(Error('Peer ended the session'), { status: 401 });
        }
      } catch (e) {
        error(e);
        if ([401, 404].includes(e.status)) {
          if (transfer?.approved && channel?.readyState === 'open') {
            status(
              'Peer connection remains active, but signaling expired. Re-pair after disconnection.',
            );
            break;
          }
          await leave(false);
          break;
        }
      }
      await sleep(2000);
    }
  } finally {
    polling = false;
    if (session && run !== attempt) void poll();
  }
}
async function begin(join) {
  if (starting) return;
  starting = true;
  $('create').disabled = $('join').disabled = true;
  try {
    await beginSession(join);
  } finally {
    starting = false;
    $('create').disabled = $('join').disabled = false;
  }
}
async function beginSession(join) {
  $('error').textContent = '';
  if (session) throw Error('End the current session first.');
  if (!window.isSecureContext || !window.RTCPeerConnection)
    throw Error('Open the client over HTTPS in a WebRTC-capable browser.');
  if (config.mode === 'browser') await prepareDownloads();
  const service = serviceUrl($('service').value);
  let code = $('code').value.trim();
  if ((join && code.startsWith('https://')) || (join && code.startsWith('http://'))) {
    const invitation = new URL(code);
    const params = new URLSearchParams(invitation.hash.slice(1));
    if (params.get('service') !== service)
      throw Error('Invitation service does not match the selected service.');
    code = params.get('room') ?? '';
  }
  status('Connecting to signaling…');
  const result = await request(join ? '/v1/join' : '/v1/rooms', {
    method: 'POST',
    body: join ? { code } : {},
    authenticated: false,
  });
  session = { ...result, service };
  $('relay-option').hidden = result.config.connectivityMode !== 'turn-enabled';
  if (result.config.connectivityMode !== 'turn-enabled') $('relay').checked = false;
  pinnedIdentity = null;
  recoveryDeadline = 0;
  attempt++;
  $('setup').hidden = true;
  $('leave').hidden = false;
  if (!join) {
    // Keep browser invitations on the trusted client origin, even when an
    // independently hosted signaling service is used.
    const link = new URL('/internet/', config.mode === 'browser' ? location.origin : service);
    link.hash = new URLSearchParams({ service, room: result.id }).toString();
    $('share').href = link.href;
    $('share').textContent = link.href;
    $('session-code').textContent = result.code;
    $('qr').src = await QRCode.toDataURL(link.href, { width: 220 });
    $('expires').textContent =
      `Invitation expires at ${new Date(result.invitationExpires).toLocaleTimeString()}. Established sessions stay active.`;
    $('invitation').hidden = false;
  }
  status('Waiting for the other device.');
  void poll();
}
async function leave(notify = true) {
  clearTimeout(connectionTimer);
  clearInterval(diagnosticsTimer);
  if (notify && session)
    await request(`/v1/rooms/${session.id}`, { method: 'DELETE' }).catch(() => {});
  session = null;
  attempt++;
  pinnedIdentity = null;
  recoveryDeadline = 0;
  offerDecision?.(false);
  offerDecision = null;
  await transfer?.abort();
  if (channel) {
    channel.onclose = null;
    channel.close();
  }
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
  }
  pc = null;
  channel = null;
  transfer = null;
  for (const id of ['files', 'invitation', 'verification', 'incoming', 'leave', 'retry'])
    $(id).hidden = true;
  $('setup').hidden = false;
  status('Session ended. Originals were preserved.');
}
async function sendFiles(files) {
  try {
    for (const file of files) await transfer.send(file, file.webkitRelativePath || file.name);
  } catch (e) {
    error(e);
  }
}
$('create').onclick = () => begin(false).catch(error);
$('join').onclick = () => begin(true).catch(error);
$('leave').onclick = () => leave().catch(error);
$('reject').onclick = () => leave().catch(error);
$('approve').onclick = () => {
  if (!channel || channel.readyState !== 'open' || !currentIdentity) return;
  localApproved = true;
  $('approve').disabled = true;
  channel.send(JSON.stringify({ type: 'approved' }));
  updateReady();
};
$('accept').onclick = () => {
  $('incoming').hidden = true;
  offerDecision?.(true);
  offerDecision = null;
};
$('decline').onclick = () => {
  $('incoming').hidden = true;
  offerDecision?.(false);
  offerDecision = null;
};
$('cancel').onclick = () => transfer?.cancel().catch(error);
$('retry').onclick = () =>
  (session.role === 'owner' ? offer() : signal({ type: 'restart' })).catch(error);
$('picker').onchange = (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  void sendFiles(files);
};
$('drop').ondragover = (event) => event.preventDefault();
$('drop').ondrop = (event) => {
  event.preventDefault();
  void sendFiles(event.dataTransfer.files);
};
window.addEventListener('beforeunload', (event) => {
  if (transfer?.incoming || transfer?.outgoing) {
    event.preventDefault();
    event.returnValue = '';
  }
});

async function init() {
  config = await fetch('/internet/config', { cache: 'no-store' }).then((r) => r.json());
  const invitation = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  $('service').value =
    invitation.get('service') ??
    config.signalingUrl ??
    (config.mode === 'browser' ? location.origin : '');
  $('code').value = invitation.get('room') ?? '';
  $('destination').textContent =
    config.mode === 'browser'
      ? 'Receives use your browser download settings. Completion means verified download handoff; it does not authorize deleting originals.'
      : 'Receives are verified and committed to this device’s Downloads destination.';
  $('relay-option').hidden = config.connectivityMode !== 'turn-enabled';
  status('Ready. Create a session or enter an invitation.');
}
init().catch(error);
