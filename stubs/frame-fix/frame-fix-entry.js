// Load frame fix first
require('./frame-fix-wrapper.js');

// Then load the patched Electron main process.
//
// Newer Claude Desktop builds (observed on asar 1.19367.0+) split the main
// entry into two files:
//   - index.pre.js — the real entry: it stashes the @sentry/electron/main
//     namespace on globalThis.__sentryElectronMain, then require()s index.js.
//   - index.js — carries the yukonSilver/cowork patches, but now begins with a
//     "sentryMainShim" guard that throws if __sentryElectronMain is unset.
// Requiring index.js directly skips the stash, so the shim throws and the main
// process crashes on launch (issue #154). Older single-entry builds have no
// index.pre.js and must load index.js directly.
//
// Prefer index.pre.js when it exists so the stash runs (it then pulls in the
// still-patched index.js); fall back to index.js otherwise. Runtime detection
// keeps both asar layouts working with no version assumption baked in.
const fs = require('fs');
const path = require('path');
const buildDir = path.join(__dirname, '.vite', 'build');
const preEntry = path.join(buildDir, 'index.pre.js');
require(fs.existsSync(preEntry) ? preEntry : path.join(buildDir, 'index.js'));
