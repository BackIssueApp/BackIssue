// Run an async task over many items with bounded concurrency, where each worker
// owns a reusable resource (e.g. a browser page) for its lifetime.
//
//   await poolWithResource(items, 4, () => context.newPage(), async (item, i, page) => {...}, (page) => page.close());
//
// Spawns min(concurrency, items.length) workers. Each creates one resource,
// pulls items off a shared cursor until exhausted, then disposes its resource.
export async function poolWithResource(items, concurrency, createResource, fn, disposeResource = async () => {}) {
  const n = Math.max(1, Math.min(concurrency, items.length));
  if (n === 0) return;
  let cursor = 0;
  const worker = async () => {
    const resource = await createResource();
    try {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        await fn(items[i], i, resource);
      }
    } finally {
      await disposeResource(resource);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}
