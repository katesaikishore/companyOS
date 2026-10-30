'use strict';

// Tests for the native messaging host's framing and relay. Each test starts host.js as a child process, the way Chrome
// does, and stands in for the desktop bridge with a local socket. Run with:
//   node --test apps/browser-ext/test/host.test.js

const { test: baseTest } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// The stand-in bridge listens on a Unix socket, which Windows does not support here. The browser bridge is off on Windows
// (native-host-install refuses to install there), so these tests skip on Windows rather than fail for that reason.
const WINDOWS_SKIP = process.platform === 'win32' ? 'the browser bridge uses Unix sockets, which Windows does not support here' : false;
const test = (name, fn) => baseTest(name, { skip: WINDOWS_SKIP }, fn);
const { spawn } = require('node:child_process');

const HOST = path.join(__dirname, '..', 'native-host', 'host.js');
const TOKEN = 'a'.repeat(64);
const VISIT = { type: 'visit', browser: 'chrome', template: 'docs.example.com/doc/:id' };

/** A private folder with the socket and token paths the launcher would pass to the host. */
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-host-'));
  return { dir, socketPath: path.join(dir, 'bridge.sock'), tokenPath: path.join(dir, 'bridge.token') };
}

/**
 * A stand-in for the desktop bridge. It records each request line. The reply comes from the test: an object is sent as
 * JSON, and a string is sent as it is.
 */
function fakeBridge(socketPath, reply = () => ({ ok: true })) {
  const requests = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let received = '';
    socket.on('error', () => undefined);
    socket.on('data', chunk => {
      received += chunk;
      const end = received.indexOf('\n');
      if (end < 0) return;
      requests.push(JSON.parse(received.slice(0, end)));
      const answer = reply(requests[requests.length - 1]);
      socket.end(typeof answer === 'string' ? `${answer}\n` : `${JSON.stringify(answer)}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () =>
      resolve({ requests, close: () => new Promise(done => server.close(() => done())) }),
    );
  });
}

/** One message in the native messaging format: a 4-byte little-endian length, then the JSON body. */
function frame(message) {
  const body = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Splits the host's output into replies. Fails when the bytes are not whole frames, so nothing else may be on stdout. */
function unframe(buffer) {
  const replies = [];
  let rest = buffer;
  while (rest.length > 0) {
    assert.ok(rest.length >= 4, 'a reply header is cut short');
    const length = rest.readUInt32LE(0);
    assert.ok(rest.length >= 4 + length, 'a reply body is cut short');
    replies.push(JSON.parse(rest.subarray(4, 4 + length).toString('utf8')));
    rest = rest.subarray(4 + length);
  }
  return replies;
}

/** Starts the host with the paths in its environment, as the launcher does, and collects everything it writes. */
function runHost({ socketPath, tokenPath }) {
  const child = spawn(process.execPath, [HOST], {
    env: { COMPANYOS_TWIN_SOCKET: socketPath, COMPANYOS_TWIN_TOKEN: tokenPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.on('error', () => undefined);
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return {
    write: buffer => child.stdin.write(buffer),
    exited,
    /** Closes stdin the way Chrome does when it has no more messages, then waits for the host to exit. */
    finish: async () => {
      child.stdin.end();
      const code = await exited;
      return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    },
  };
}

function writeToken(ws) {
  fs.writeFileSync(ws.tokenPath, `${TOKEN}\n`, { mode: 0o600 });
}

test('relays a visit with the token from the token file, and frames the bridge reply back', async () => {
  const ws = workspace();
  try {
    writeToken(ws);
    const bridge = await fakeBridge(ws.socketPath);
    try {
      const host = runHost(ws);
      host.write(frame(VISIT));
      const result = await host.finish();

      assert.equal(result.code, 0);
      assert.deepEqual(unframe(result.stdout), [{ ok: true }]);
      assert.equal(result.stderr.length, 0, 'the host never writes to stderr');
      assert.deepEqual(bridge.requests, [{ ...VISIT, token: TOKEN }]);
    } finally {
      await bridge.close();
    }
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('forwards only the fields the bridge expects, so an extension cannot add others', async () => {
  const ws = workspace();
  try {
    writeToken(ws);
    const bridge = await fakeBridge(ws.socketPath);
    try {
      const host = runHost(ws);
      host.write(frame({ ...VISIT, url: 'https://docs.example.com/doc?token=SECRET123456', title: 'SECRET title' }));
      await host.finish();

      assert.equal(bridge.requests.length, 1);
      assert.deepEqual(Object.keys(bridge.requests[0]).sort(), ['browser', 'template', 'token', 'type']);
      assert.ok(!JSON.stringify(bridge.requests[0]).includes('SECRET'));
    } finally {
      await bridge.close();
    }
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('refuses a message with the wrong shape without contacting the bridge', async () => {
  const ws = workspace();
  try {
    writeToken(ws);
    const bridge = await fakeBridge(ws.socketPath);
    try {
      const host = runHost(ws);
      const bad = [
        'not json',
        '[]',
        { ...VISIT, type: 'focus' },
        { ...VISIT, browser: 'firefox' },
        { ...VISIT, template: 42 },
        { ...VISIT, template: 'a'.repeat(301) },
        {},
      ];
      for (const message of bad) host.write(frame(message));
      const result = await host.finish();

      assert.equal(result.code, 0);
      assert.deepEqual(unframe(result.stdout), bad.map(() => ({ ok: false, error: 'bad_request' })));
      assert.deepEqual(bridge.requests, []);
    } finally {
      await bridge.close();
    }
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('passes the bridge reply through, including its refusal codes', async () => {
  const ws = workspace();
  try {
    writeToken(ws);
    const bridge = await fakeBridge(ws.socketPath, () => ({ ok: false, error: 'unauthorized' }));
    try {
      const host = runHost(ws);
      host.write(frame(VISIT));
      const result = await host.finish();
      assert.deepEqual(unframe(result.stdout), [{ ok: false, error: 'unauthorized' }]);
    } finally {
      await bridge.close();
    }
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('leaves a malformed template to the bridge, which checks the template itself', async () => {
  const ws = workspace();
  try {
    writeToken(ws);
    const bridge = await fakeBridge(ws.socketPath);
    try {
      const host = runHost(ws);
      host.write(frame({ ...VISIT, template: 'docs.example.com/doc?token=SECRET' }));
      const result = await host.finish();
      // The host checks only the envelope. The bridge runs the full template check on what it receives.
      assert.equal(bridge.requests.length, 1);
      assert.deepEqual(unframe(result.stdout), [{ ok: true }]);
    } finally {
      await bridge.close();
    }
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('reads messages that arrive in pieces, and replies to several in order', async () => {
  const ws = workspace();
  try {
    writeToken(ws);
    const bridge = await fakeBridge(ws.socketPath);
    try {
      const first = frame({ ...VISIT, template: 'one.example.com' });
      const second = frame({ ...VISIT, template: 'two.example.com/a' });
      const third = frame({ ...VISIT, template: 'three.example.com/a/:id' });
      const host = runHost(ws);
      host.write(first.subarray(0, 3));
      host.write(first.subarray(3));
      host.write(Buffer.concat([second, third]));
      const result = await host.finish();

      assert.deepEqual(unframe(result.stdout), [{ ok: true }, { ok: true }, { ok: true }]);
      assert.deepEqual(
        bridge.requests.map(request => request.template),
        ['one.example.com', 'two.example.com/a', 'three.example.com/a/:id'],
      );
    } finally {
      await bridge.close();
    }
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('reports app_not_running when the token file is missing', async () => {
  const ws = workspace();
  try {
    const host = runHost(ws);
    host.write(frame(VISIT));
    const result = await host.finish();
    assert.deepEqual(unframe(result.stdout), [{ ok: false, error: 'app_not_running' }]);
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('reports app_not_running when no bridge is listening on the socket', async () => {
  const ws = workspace();
  try {
    writeToken(ws);
    const host = runHost(ws);
    host.write(frame(VISIT));
    const result = await host.finish();
    assert.deepEqual(unframe(result.stdout), [{ ok: false, error: 'app_not_running' }]);
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('reports bad_reply when the bridge answers with something other than JSON', async () => {
  const ws = workspace();
  try {
    writeToken(ws);
    const bridge = await fakeBridge(ws.socketPath, () => 'this is not json');
    try {
      const host = runHost(ws);
      host.write(frame(VISIT));
      const result = await host.finish();
      assert.deepEqual(unframe(result.stdout), [{ ok: false, error: 'bad_reply' }]);
    } finally {
      await bridge.close();
    }
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('stops without a reply when a message is larger than the host accepts', async () => {
  const ws = workspace();
  try {
    writeToken(ws);
    const bridge = await fakeBridge(ws.socketPath);
    try {
      const host = runHost(ws);
      const oversized = Buffer.alloc(4 + 5000, 'x');
      oversized.writeUInt32LE(5000, 0);
      host.write(oversized);
      const code = await host.exited;

      assert.equal(code, 1);
      assert.deepEqual(bridge.requests, []);
    } finally {
      await bridge.close();
    }
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('exits cleanly with no output when Chrome closes stdin without a message', async () => {
  const ws = workspace();
  try {
    const result = await runHost(ws).finish();
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.length, 0);
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});
