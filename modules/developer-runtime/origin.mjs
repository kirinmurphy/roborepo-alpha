export function originCandidatesForListener(listener, preference = null) {
  const hosts = compatibleLoopbackHosts(listener.address);
  if (preference === "localhost" && hosts.includes("localhost")) {
    hosts.splice(hosts.indexOf("localhost"), 1);
    hosts.unshift("localhost");
  }
  const protocol = listener.port === 443 ? "https" : "http";
  return hosts.map((host) => ({
    protocol,
    host,
    port: listener.port,
    origin: `${protocol}://${host === "::1" ? "[::1]" : host}${listener.port === 443 ? "" : `:${listener.port}`}`,
  }));
}

function compatibleLoopbackHosts(address) {
  if (address === "::1") return ["::1", "localhost"];
  if (address === "127.0.0.1") return ["127.0.0.1", "localhost"];
  if (address === "localhost") return ["localhost", "127.0.0.1", "::1"];
  if (address === "*" || address === "0.0.0.0" || address === "::") return ["localhost", "127.0.0.1", "::1"];
  return [];
}
