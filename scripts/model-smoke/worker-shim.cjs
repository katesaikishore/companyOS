// Runs the app's compiled model worker under plain Node, so it can be checked outside Electron.
//
// In the app, apps/desktop/dist/main/llm-worker.js is the entry point of an Electron utility process and talks to the
// main process through process.parentPort. A Node child process has process.send and process.on('message') instead.
// This file puts a parentPort in front of those two and then loads the worker file unchanged.
// The difference from the app is the host process only. The worker code, node-llama-cpp and the model are the same.
const path = require('node:path');

if (typeof process.send !== 'function') throw new Error('Start this file with child_process.fork.');

process.parentPort = {
  postMessage: message => process.send(message),
  on: (event, listener) => {
    if (event === 'message') process.on('message', data => listener({ data }));
  },
};

require(path.join(__dirname, '..', '..', 'apps', 'desktop', 'dist', 'main', 'llm-worker.js'));
