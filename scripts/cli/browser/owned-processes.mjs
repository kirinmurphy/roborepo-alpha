// Processes a browser run started and must stop however the run ends: normally, on a timeout, or
// when the CLI itself is interrupted (Ctrl-C, or a harness killing a long command). Each owner
// registers its own stop function, because a dev server's process group and a test runner that
// needs a graceful interrupt are stopped differently.

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
