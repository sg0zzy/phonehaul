export async function prepareDownloads() {
  if (!('serviceWorker' in navigator))
    throw Error('Streaming downloads are unavailable in this browser.');
  await navigator.serviceWorker.register('/internet/sw.js', { scope: '/internet/' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('Download worker could not take control. Reload this page.')),
        10_000,
      );
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

export async function downloadSink(file) {
  await prepareDownloads();
  const ports = new MessageChannel();
  let demand = 0,
    stopped = false,
    pending,
    registered,
    ended,
    failed;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Download worker unavailable')), 10_000);
    registered = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const complete = new Promise((resolve, reject) => {
    ended = resolve;
    failed = reject;
  });
  complete.catch(() => {});
  ports.port1.onmessage = ({ data }) => {
    if (data.type === 'registered') registered();
    if (data.type === 'pull') {
      demand++;
      pending?.();
      pending = null;
    }
    if (data.type === 'cancelled') {
      stopped = true;
      failed(Error('Browser download cancelled'));
      pending?.();
      pending = null;
    }
    if (data.type === 'ended') ended();
  };
  navigator.serviceWorker.controller.postMessage(
    { type: 'download', id: file.id, name: file.relativePath.split('/').at(-1) },
    [ports.port2],
  );
  await ready;
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = `/internet/download/${file.id}`;
  document.body.append(frame);
  return {
    async write(bytes) {
      if (!demand && !stopped)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error('Download stopped accepting data. Retry from the beginning.')),
            60_000,
          );
          pending = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      if (stopped) throw Error('Browser download was cancelled');
      demand--;
      const copy = bytes.slice().buffer;
      ports.port1.postMessage({ type: 'chunk', bytes: copy }, [copy]);
    },
    async finish() {
      const timer = setTimeout(() => failed(Error('Download completion timed out')), 60_000);
      ports.port1.postMessage({ type: 'end' });
      try {
        await complete;
      } finally {
        clearTimeout(timer);
      }
      ports.port1.close();
      // Removing the navigation immediately can cancel a small download before
      // the browser has handed it to its download manager.
      setTimeout(() => frame.remove(), 60_000);
      return { status: 'download-handed-off' };
    },
    async abort() {
      stopped = true;
      failed(Error('Download aborted'));
      pending?.();
      ports.port1.postMessage({ type: 'abort' });
      ports.port1.close();
      frame.remove();
    },
  };
}
