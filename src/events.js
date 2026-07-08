// SSE hub for /api/events — the push channel that replaces the UI's fixed
// polling loops. Rather than instrumenting every subsystem with emitters, the
// hub computes a cheap change signature per domain on a short tick (only while
// at least one client is connected) and tells clients WHICH domains changed;
// they re-fetch just those endpoints. One connection, no wasted requests, and
// updates land within a tick instead of a poll interval.
export function createEventHub(signatures, { tickMs = 750, heartbeatMs = 25000 } = {}) {
  const clients = new Set();
  let last = {};
  let timer = null;
  let beat = null;

  function broadcast(chunk) {
    for (const res of clients) {
      try { res.write(chunk); } catch { clients.delete(res); }
    }
  }

  function tick() {
    const changed = [];
    for (const [key, fn] of Object.entries(signatures)) {
      let sig;
      try { sig = JSON.stringify(fn()); } catch { continue; } // a failing probe never kills the stream
      if (last[key] !== sig) { last[key] = sig; changed.push(key); }
    }
    if (changed.length) broadcast(`event: changed\ndata: ${JSON.stringify(changed)}\n\n`);
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, tickMs);
    beat = setInterval(() => broadcast(': ping\n\n'), heartbeatMs); // keep proxies from idling us out
  }
  function stop() {
    clearInterval(timer); clearInterval(beat);
    timer = beat = null;
    last = {}; // next client's first tick re-reports everything → a fresh full refresh
  }

  return {
    handler(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // nginx: don't buffer the stream
      });
      res.write('event: hello\ndata: {}\n\n');
      clients.add(res);
      start();
      req.on('close', () => {
        clients.delete(res);
        if (!clients.size) stop(); // no listeners → no ticking
      });
    },
    clientCount: () => clients.size,
    tick, // exposed for tests
  };
}
