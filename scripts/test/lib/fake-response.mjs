// A minimal stand-in for http.ServerResponse that route-table checks can hand to dispatchRoutes()
// without binding a port. It records the status, headers, and body the handler wrote; write() and
// end(chunk) append the way Node's streaming response does.
export function fakeResponse() {
  return {
    statusCode: null, headers: {}, body: null, ended: false,
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) { this.body = (this.body ?? "") + String(chunk); return true; },
    end(chunk) { if (chunk != null) this.write(chunk); this.ended = true; return this; },
  };
}
