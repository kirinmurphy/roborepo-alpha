// Small helpers for checks that start throwaway local HTTP servers: find a free port, ask whether
// something answers on one, and serve a one-heading fixture page.
import http from "node:http";
import net from "node:net";

export function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function responds(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

// Serves `<h1>Fixture</h1>` from this process on a free loopback port.
export function startFixtureApp() {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Fixture</title><h1>Fixture</h1>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() });
    });
  });
}
