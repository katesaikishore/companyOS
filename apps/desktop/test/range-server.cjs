// A stand-in for Hugging Face, for tests. It serves a small bundle under /<repo>/resolve/<revision>/<file>, honours
// HTTP Range, and can misbehave on request: truncate or stall a body, corrupt bytes, ignore Range, send a wrong range
// or an extra byte, refuse an offset, or redirect to a second path the way Hugging Face redirects to its CDN.
//
// Used by the Vitest suite and by the end-to-end script, so it is plain CommonJS with no dependency.
const http = require('node:http');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param files   Object of file path to Buffer.
 * @param options { revision, repo?, redirect?, chunkBytes?, chunkDelayMs? }
 *                redirect: send every /resolve/ request to /cdn/<file> first.
 * The returned `rules` array holds functions (info) => action | undefined, checked in order. info is
 * { name, via: 'resolve' | 'cdn', start, ranged, count } and `count` is the number of requests for that file so far.
 * An action may set: truncateAt, stallAt (send that many bytes of the body, then cut the connection or hold it open),
 * corrupt, extra (Buffer appended), shorten (cut the file to that many bytes), ignoreRange, noLength (chunked body),
 * badRange (a Content-Range value), status (answer with only that status), redirectTo (a full URL).
 */
function createRangeServer(files, options) {
  const repo = options.repo || 'receptron/laya-onnx';
  const prefix = `/${repo}/resolve/${options.revision}/`;
  const chunk = options.chunkBytes || 65536;
  const requests = [];
  const counts = new Map();
  const rules = [];
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    const url = new URL(req.url, 'http://localhost');
    let name;
    let via = 'resolve';
    if (url.pathname.startsWith(prefix)) name = decodeURIComponent(url.pathname.slice(prefix.length));
    else if (url.pathname.startsWith('/cdn/')) {
      name = decodeURIComponent(url.pathname.slice(5));
      via = 'cdn';
    }
    const body = name === undefined ? undefined : files[name];
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    const count = (counts.get(name) || 0) + 1;
    counts.set(name, count);
    const match = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    const action = rules.map(rule => rule({ name, via, start, ranged: Boolean(match), count })).find(Boolean) || {};

    if (via === 'resolve' && (options.redirect || action.redirectTo)) {
      res.writeHead(302, { location: action.redirectTo || `/cdn/${name}` });
      res.end();
      return;
    }
    if (action.status) {
      res.writeHead(action.status);
      res.end();
      return;
    }

    let payload = body;
    if (action.corrupt) {
      payload = Buffer.from(body);
      payload[Math.floor(payload.length / 2)] ^= 0xff;
    }
    if (action.extra) payload = Buffer.concat([payload, action.extra]);
    if (action.shorten !== undefined) payload = payload.subarray(0, action.shorten);

    const ranged = Boolean(match) && !action.ignoreRange;
    if (ranged && start >= payload.length) {
      res.writeHead(416, { 'content-range': `bytes */${payload.length}` });
      res.end();
      return;
    }
    const slice = ranged ? payload.subarray(start) : payload;
    const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
    if (!action.noLength) headers['content-length'] = String(slice.length);
    if (ranged) headers['content-range'] = action.badRange || `bytes ${start}-${payload.length - 1}/${payload.length}`;
    res.writeHead(ranged ? 206 : 200, headers);

    const limit = action.truncateAt !== undefined ? action.truncateAt : action.stallAt !== undefined ? action.stallAt : slice.length;
    for (let at = 0; at < limit; at += chunk) {
      if (res.destroyed) return;
      const piece = slice.subarray(at, Math.min(at + chunk, limit));
      await new Promise(resolve => res.write(piece, resolve));
      if (options.chunkDelayMs) await sleep(options.chunkDelayMs);
    }
    if (action.truncateAt !== undefined) {
      // A graceful close after the bytes: the client reads every byte sent, then sees the body end early. Destroying the
      // socket instead would send a reset, and the client may drop the bytes it had not read yet.
      res.socket.end();
      return;
    }
    if (action.stallAt !== undefined) return; // hold the connection open until the client gives up
    res.end();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        rules,
        close: () =>
          new Promise(done => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { createRangeServer };
