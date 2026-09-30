import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

const $ = (id) => document.getElementById(id);
const message = (text) => { $('message').textContent = text || ''; };
let pairingVersion = null;
function update(data) {
  if (data.server) {
    $('server').textContent = data.server.running ? 'Running' : 'Stopped';
    $('address').textContent = data.server.running ? `Phone connection: ${data.server.host}:${data.server.port}` : data.server.error || 'Server stopped';
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
  if (typeof ui.pairingComplete === 'boolean') {
    $('qr').hidden = ui.pairingComplete;
    $('pairing-expiry').hidden = ui.pairingComplete;
    $('pairing-copy').textContent = ui.pairingComplete
      ? (ui.connected ? 'Phone paired. The QR code is hidden.' : 'Phone paired but not currently connected. Generate a new code to pair again.')
      : 'Open PhoneHaul on your Android phone and scan this code.';
    $('refresh-qr').hidden = Boolean(ui.connected);
  }
  $('device').textContent = ui.connected ? 'Phone connected' : 'No phone connected';
  if (data.server?.running) $('pairing').hidden = false;
  const active = ui.transfer;
  if (active) {
    $('transfer').textContent = active.finished ? (active.cancelled ? 'Transfer cancelled' : 'Transfer complete') : `Receiving ${active.completedItems || 0} of ${active.totalItems || 0} files${active.currentItem ? ` — ${active.currentItem}` : ''}`;
    $('progress').value = active.totalBytes ? (active.receivedBytes || 0) / active.totalBytes : 0;
  } else { $('transfer').textContent = 'Idle'; $('progress').value = 0; }
  const q = ui.sendQueue;
  if (q) { $('queue').replaceChildren(...q.map(item => { const li=document.createElement('li');const progress=item.size&&item.state==='sending'?` — ${Math.floor(item.progress/item.size*100)}%`:'';li.textContent=`${item.name} — ${item.state}${progress}`;return li; })); }
}
async function refresh() { try { update(await invoke('get_status')); } catch (e) { message(String(e)); } }
await listen('phonehaul://status', ({ payload }) => update(payload));
await refresh();
$('change-destination').addEventListener('click', async () => {
  try { await invoke('set_destination'); await refresh(); message('Destination updated.'); } catch (e) { message(String(e)); }
});
$('refresh-qr').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    await invoke('refresh_qr');
    await refresh();
    message('Pairing QR code refreshed.');
  } catch (e) { message(String(e)); }
  finally { event.currentTarget.disabled = false; }
});
$('send').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true; message('Select files to send…');
  try { await invoke('send_files'); message('Files queued for the phone.'); await refresh(); }
  catch (e) { message(String(e)); }
  finally { event.currentTarget.disabled = false; }
});

const dropArea = $('drop-area');
dropArea.addEventListener('click', () => $('send').click());
dropArea.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    $('send').click();
  }
});
const isOverDropArea = (position) => {
  const rect = dropArea.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
};
await getCurrentWebview().onDragDropEvent(async ({ payload }) => {
  if (payload.type === 'enter' || payload.type === 'over') {
    dropArea.classList.toggle('dragging', isOverDropArea(payload.position));
    return;
  }
  if (payload.type === 'leave') {
    dropArea.classList.remove('dragging');
    return;
  }
  dropArea.classList.remove('dragging');
  if (!isOverDropArea(payload.position)) {
    await invoke('clear_dropped_paths').catch(() => {});
    return;
  }
  message('Queueing dropped files…');
  try {
    const count = await invoke('queue_dropped_paths');
    message(count ? `${count} file${count === 1 ? '' : 's'} queued for the phone.` : 'No files found in the dropped folders.');
    await refresh();
  } catch (error) {
    message(String(error));
  }
});
