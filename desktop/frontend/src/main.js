import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

const $ = (id) => document.getElementById(id);
const message = (text) => {
  $('message').textContent = text || '';
};
let pairingVersion = null;

// Inline Material Symbols: replace <span data-icon="name"> with the bundled
// SVG so icons inherit currentColor without any runtime font/CDN loading.
const icons = import.meta.glob('./icons/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const icon = (name) => icons[`./icons/${name}.svg`] || '';
for (const el of document.querySelectorAll('[data-icon]')) {
  const svg = icon(el.dataset.icon);
  if (svg) {
    el.innerHTML = svg;
    // Copy any extra classes (e.g. "small") onto the svg element itself.
    if (el.className) el.firstElementChild.classList.add(...el.className.split(' '));
    if (el.id) el.firstElementChild.id = el.id;
  }
}
// Swap an already-inlined icon at runtime.
function setIcon(el, name) {
  const svg = icon(name);
  if (!svg) return;
  const cls = [...el.classList];
  el.innerHTML = svg;
  for (const c of cls) el.firstElementChild.classList.add(c);
  if (el.id) el.firstElementChild.id = el.id;
}

// Server status chip: states derive only from receiver-reported data.
function updateServerChip(server) {
  const chip = $('server');
  const icon = chip.querySelector('.ms-icon');
  let label = 'Starting…';
  let state = 'starting';
  if (server) {
    if (server.running) {
      label = 'Ready';
      state = 'ready';
    } else {
      label = 'Error';
      state = 'error';
      chip.title = server.error || 'Server stopped';
    }
  }
  chip.setAttribute('data-status', state);
  if (icon) setIcon(icon, 'circle');
  chip.setAttribute('aria-live', 'polite');
  chip.childNodes[chip.childNodes.length - 1].textContent = label;
}

function update(data) {
  updateServerChip(data.server);
  if (data.server) {
    $('address').querySelector('.address-text').textContent = data.server.running
      ? `${data.server.host}:${data.server.port}`
      : data.server.error || 'Server stopped';
    if (!data.server.running) $('pairing').hidden = true;
  }
  const ui = data.ui || data;
  if (ui.settings) $('destination').textContent = ui.settings.destination;
  if (ui.qr) $('qr').src = ui.qr;
  if (Number.isInteger(ui.pairingVersion)) {
    const changed = pairingVersion !== null && pairingVersion !== ui.pairingVersion;
    pairingVersion = ui.pairingVersion;
    if (changed && !ui.qr && !ui.connected) refresh().catch((e) => message(String(e)));
  }
  if (typeof ui.paired === 'boolean') {
    // paired = pairing session exists; a quiet (backgrounded) phone stays paired.
    // While paired but not connected (connection interrupted, phone quiet) the
    // refresh button stays available so the user can force a fresh QR instead of
    // waiting out the stale-session reset.
    const paired = ui.paired;
    $('qr').hidden = paired;
    $('pairing-expiry').hidden = paired;
    $('pairing-copy').textContent = paired
      ? 'Phone paired. The QR code is hidden.'
      : 'Scan this code with PhoneHaul on Android.';
    $('refresh-qr').hidden = paired && ui.connected;
  }
  const connected = Boolean(ui.connected);
  $('device').querySelector('.device-text').textContent = connected
    ? 'Phone connected'
    : 'No phone connected';
  $('device').classList.toggle('connected', connected);
  // Send controls require a paired phone; disable while no phone is connected.
  $('send').disabled = !connected;
  $('drop-area').setAttribute('aria-disabled', String(!connected));
  $('drop-area').classList.toggle('disabled', !connected);
  if (data.server?.running) $('pairing').hidden = false;
  const active = ui.transfer;
  const progress = $('progress');
  const status = $('transfer-status');
  if (active) {
    if (active.finished) {
      const failed = Boolean(active.cancelled) || Boolean(active.error);
      status.dataset.state = failed ? 'error' : 'done';
      setIcon($('transfer-icon'), failed ? 'error' : 'check_circle');
      $('transfer').textContent = active.cancelled
        ? 'Transfer cancelled'
        : active.error
          ? `Transfer failed — ${active.error}`
          : 'Transfer complete';
    } else {
      status.dataset.state = 'active';
      setIcon($('transfer-icon'), 'sync');
      $('transfer').textContent = `Receiving ${active.completedItems || 0} of ${
        active.totalItems || 0
      } files${active.currentItem ? ` — ${active.currentItem}` : ''}`;
    }
    progress.hidden = false;
    progress.value = active.totalBytes ? (active.receivedBytes || 0) / active.totalBytes : 0;
  } else {
    status.dataset.state = 'idle';
    setIcon($('transfer-icon'), 'hourglass_empty');
    $('transfer').textContent = 'No active transfers';
    progress.hidden = true;
    progress.value = 0;
  }
  const q = ui.sendQueue;
  if (q) {
    $('queue').replaceChildren(
      ...q.map((item) => {
        const li = document.createElement('li');
        const pct =
          item.size && item.state === 'sending'
            ? ` — ${Math.floor((item.progress / item.size) * 100)}%`
            : '';
        li.textContent = `${item.name} — ${item.state}${pct}`;
        return li;
      }),
    );
  }
}
async function refresh() {
  try {
    update(await invoke('get_status'));
  } catch (e) {
    message(String(e));
  }
}
await listen('phonehaul://status', ({ payload }) => update(payload));
await refresh();
$('change-destination').addEventListener('click', async () => {
  try {
    await invoke('set_destination');
    await refresh();
    message('Destination updated.');
  } catch (e) {
    message(String(e));
  }
});
$('refresh-qr').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    await invoke('refresh_qr');
    await refresh();
    message('Pairing QR code refreshed.');
  } catch (e) {
    message(String(e));
  } finally {
    event.currentTarget.disabled = false;
  }
});
$('send').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  message('Select files to send…');
  try {
    await invoke('send_files');
    message('Files queued for the phone.');
    await refresh();
  } catch (e) {
    message(String(e));
  } finally {
    event.currentTarget.disabled = false;
  }
});

const dropArea = $('drop-area');
function openPicker() {
  if (dropArea.classList.contains('disabled')) return;
  $('send').click();
}
dropArea.addEventListener('click', openPicker);
dropArea.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openPicker();
  }
});
await getCurrentWebview().onDragDropEvent(async ({ payload }) => {
  if (payload.type === 'enter' || payload.type === 'over') {
    // Tauri reports native drag positions in physical pixels, while the DOM
    // uses CSS pixels. The mapping can be wrong with display scaling, so treat
    // the whole app window as the drop target instead of silently rejecting a
    // valid drop based on a fragile coordinate comparison.
    if (!dropArea.classList.contains('disabled')) dropArea.classList.add('dragging');
    return;
  }
  if (payload.type === 'leave') {
    dropArea.classList.remove('dragging');
    return;
  }
  dropArea.classList.remove('dragging');
  message('Queueing dropped files…');
  try {
    const count = await invoke('queue_dropped_paths', { paths: payload.paths });
    message(
      count
        ? `${count} file${count === 1 ? '' : 's'} queued for the phone.`
        : 'No files found in the dropped folders.',
    );
    await refresh();
  } catch (error) {
    message(String(error));
  }
});
