let tail = Promise.resolve();

async function withBrowserLock(task, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  const previous = tail;
  tail = tail.then(() => turn);

  try {
    if (!signal) {
      await previous;
    } else {
      let onAbort;
      try {
        await Promise.race([
          previous,
          new Promise((_, reject) => {
            onAbort = () => reject(signal.reason || new Error("Operation aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      signal.throwIfAborted();
    }
  } catch (error) {
    // Release a cancelled queue slot so it cannot block later browser work.
    release();
    throw error;
  }
  try {
    signal?.throwIfAborted();
    return await task();
  } finally {
    release();
  }
}

module.exports = { withBrowserLock };
