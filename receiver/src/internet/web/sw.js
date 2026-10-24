const downloads = new Map();
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'download' || !event.ports[0] || !/^[a-f0-9-]{36}$/.test(event.data.id))
    return;
  const port = event.ports[0];
  const timer = setTimeout(() => {
    downloads.delete(event.data.id);
    port.close();
  }, 60_000);
  downloads.set(event.data.id, {
    port,
    name: String(event.data.name).replace(/[\r\n]/g, '_'),
    timer,
  });
  port.postMessage({ type: 'registered' });
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/internet/download/')) return;
  const id = url.pathname.slice('/internet/download/'.length);
  const item = downloads.get(id);
  if (!item) {
    event.respondWith(new Response('Download expired', { status: 404 }));
    return;
  }
  downloads.delete(id);
  clearTimeout(item.timer);
  const stream = new ReadableStream(
    {
      start(controller) {
        item.port.onmessage = ({ data }) => {
          if (data.type === 'chunk') controller.enqueue(new Uint8Array(data.bytes));
          else if (data.type === 'end') {
            controller.close();
            item.port.postMessage({ type: 'ended' });
            item.port.close();
          } else {
            controller.error(Error('Transfer interrupted'));
            item.port.close();
          }
        };
        item.port.start();
      },
      pull() {
        item.port.postMessage({ type: 'pull' });
      },
      cancel() {
        item.port.postMessage({ type: 'cancelled' });
        item.port.close();
      },
    },
    { highWaterMark: 0 },
  );
  event.respondWith(
    new Response(stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name).replaceAll("'", '%27')}`,
      },
    }),
  );
});
