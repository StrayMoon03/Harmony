let tail = Promise.resolve();

async function withBrowserLock(task) {
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  const previous = tail;
  tail = tail.then(() => turn);

  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

module.exports = { withBrowserLock };
