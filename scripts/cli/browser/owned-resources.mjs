// What a browser run started and must clean up however the run ends: normally, on a timeout, or
// when the CLI itself is interrupted (Ctrl-C, or a harness killing a long command), which skips the
// providers' own `finally` blocks. Each owner registers its own stop function, because a dev
// server's process group, a test runner that needs a graceful interrupt, and a temp directory are
// each released differently. Stop functions run in registration order.

const owned = new Set();

// Returns the release function to call once the process has been stopped the normal way.
export function own(stop) {
  owned.add(stop);
  return () => owned.delete(stop);
}

export function stopOwned() {
  for (const stop of [...owned]) {
    owned.delete(stop);
    stop();
  }
}
