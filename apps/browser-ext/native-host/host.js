#!/usr/bin/env node
'use strict';

// companyOS Twin native messaging host. Chrome and Edge start it and send one message at a time on stdin, each
// as a 4-byte little-endian length followed by JSON. It checks the shape of the message, adds the bridge token
// from the token file, and forwards the message to the app over a local socket. Replies go back the same way.
//
// It never logs, and it writes nothing to stdout except framed replies. The app's socket and token file are
// passed in the environment by the launcher that companyOS writes when browser capture is switched on.

const fs = require('node:fs');
const net = require('node:net');

const SOCKET_PATH = process.env.COMPANYOS_TWIN_SOCKET || '';
const TOKEN_PATH = process.env.COMPANYOS_TWIN_TOKEN || '';
const MAX_INCOMING_BYTES = 4096;
const TIMEOUT_MS = 3000;

let pending = Buffer.alloc(0);
let queue = Promise.resolve();

process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    // A message this large is not from the extension. Stop instead of buffering it.
    if (length > MAX_INCOMING_BYTES) process.exit(1);
    if (pending.length < 4 + length) break;
    const body = pending.subarray(4, 4 + length);
    pending = pending.subarray(4 + length);
    queue = queue.then(() => handle(body)).catch(() => undefined);
  }
});

// Chrome closes stdin when it has no more messages. Exit once the queued replies are written.
process.stdin.on('end', () => {
  void queue.then(() => process.exit(0));
});

async function handle(body) {
  write(await relay(body));
}

async function relay(body) {
  let message;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, error: 'bad_request' };
  }
  const visit = pickVisit(message);
  if (!visit) return { ok: false, error: 'bad_request' };
  return forward(visit);
}

/** Keeps only the fields the bridge expects, so an extension cannot add others. */
function pickVisit(message) {
  if (!message || typeof message !== 'object') return undefined;
  const { type, browser, template } = message;
  if (type !== 'visit') return undefined;
  if (browser !== 'chrome' && browser !== 'edge') return undefined;
  if (typeof template !== 'string' || template.length > 300) return undefined;
  return { type, browser, template };
}

function forward(visit) {
  return new Promise(resolve => {
    let token;
    try {
      token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    } catch {
      resolve({ ok: false, error: 'app_not_running' });
      return;
    }

    const socket = net.createConnection(SOCKET_PATH);
    let received = '';
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), TIMEOUT_MS);

    function finish(reply) {
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    }

    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...visit, token })}\n`));
    socket.on('data', chunk => {
      received += chunk;
      const end = received.indexOf('\n');
      if (end >= 0) finish(parseReply(received.slice(0, end)));
    });
    socket.on('error', () => finish({ ok: false, error: 'app_not_running' }));
    socket.on('close', () => finish({ ok: false, error: 'app_closed' }));
  });
}

/** Passes the app's reply through. Its error codes are short fixed words, never message contents. */
function parseReply(line) {
  try {
    const reply = JSON.parse(line);
    if (reply && reply.ok === true) return { ok: true };
    return { ok: false, error: reply && typeof reply.error === 'string' ? reply.error : 'rejected' };
  } catch {
    return { ok: false, error: 'bad_reply' };
  }
}

function write(reply) {
  const body = Buffer.from(JSON.stringify(reply), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}
