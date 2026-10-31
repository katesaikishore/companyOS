// Loads an ES module from this CommonJS app. TypeScript turns import() into require() in a CommonJS build, and the
// @receptron/laya package is ESM, so the real import() lives here, in a plain file the compiler does not touch.
// scripts/copy-assets.mjs copies it next to the compiled main process.
'use strict';

module.exports = specifier => import(specifier);
