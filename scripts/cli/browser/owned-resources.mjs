// What a browser run started and must clean up however the run ends: normally, on a timeout, or
// when the CLI itself is interrupted (Ctrl-C, or a harness killing a long command), which skips the
// providers' own `finally` blocks. Each owner registers its own stop function, because a dev
// server's process group, a test runner that needs a graceful interrupt, and a temp directory are
// each released differently.
//
// Stop functions run newest first, the way nested resources unwind: a test runner started inside a
// temp directory has to stop, and finish writing into it, before that directory is removed. A stop
// function may return a promise, and the next one waits for it.

const owned = new Set();

// Returns the release function to call once the process has been stopped the normal way.
export function own(stop) {
  owned.add(stop);
  return () => owned.delete(stop);
}

export async function stopOwned() {
  for (const stop of [...owned].reverse()) {
    owned.delete(stop);
    try {
      await stop();
    } catch (error) {
      process.stderr.write(`browser run: cleanup failed: ${error?.message || error}\n`);
    }
  }
}
