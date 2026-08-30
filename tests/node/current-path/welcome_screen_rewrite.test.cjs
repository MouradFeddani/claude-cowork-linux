// Issue #174: the signed-out welcome screen says "Claude for Mac" on Linux
// because the heading takes its platform word from the darwin spoof. The fix
// injects a script into the renderer that rewrites the text node.
//
// What these tests are really guarding is the COST of that script, not just
// its output. The natural way to write it -- observe document.body with
// { subtree, characterData } and run a full-document TreeWalker in the
// callback -- makes every streamed token trigger a walk of every text node in
// the document. That is quadratic in conversation length, runs for the life of
// the window, and buys a cosmetic label on a screen the user sees once. So the
// assertions below pin the bounds: childList only, one walk per frame, and an
// observer that disconnects both on success and on a deadline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WRAPPER = path.join(__dirname, '..', '..', '..', 'stubs', 'frame-fix', 'frame-fix-wrapper.js');

// Pull the generator out of the wrapper the same way frame_fix_wrapper.test.cjs
// slices its helper block: the wrapper requires electron at load, so it cannot
// be required directly from a test.
//
// Deliberately NOT anchored on anything this fix introduced. An extractor that
// keys on a constant added alongside the fix cannot load the code it replaced,
// so every test fails for the same uninteresting reason and none of them
// demonstrates anything. Anchored on the function name alone, the output tests
// below pass against either implementation and only the cost tests separate
// them -- which is the actual claim being made.
function buildScript() {
  const source = fs.readFileSync(WRAPPER, 'utf8');
  const fnStart = source.indexOf('function buildMacLinuxRewriteScript');
  assert.ok(fnStart !== -1, 'could not locate buildMacLinuxRewriteScript in ' + WRAPPER);
  const end = source.indexOf('\n}', fnStart) + 2;
  assert.ok(end > fnStart, 'could not find the end of buildMacLinuxRewriteScript');

  // Any module-level constants the generator interpolates.
  const preamble = source
    .slice(0, fnStart)
    .split('\n')
    .filter((line) => /^var MAC_LINUX_[A-Z_]+ =/.test(line))
    .join('\n');

  const context = {};
  vm.createContext(context);
  vm.runInContext(preamble + '\n' + source.slice(fnStart, end), context);
  return vm.runInContext('buildMacLinuxRewriteScript()', context);
}

// ── A DOM small enough to reason about ──────────────────────────────────────

function text(value) {
  return { isText: true, nodeValue: value, parentElement: null };
}

function elem(children) {
  const node = {
    isText: false,
    children: [],
    parentElement: null,
    get textContent() {
      return collect(this);
    },
  };
  for (const child of children) {
    child.parentElement = node;
    node.children.push(child);
  }
  return node;
}

function collect(node) {
  return node.isText ? node.nodeValue : node.children.map(collect).join('');
}

function textNodesUnder(node, out = []) {
  if (node.isText) out.push(node);
  else for (const child of node.children) textNodesUnder(child, out);
  return out;
}

// A page, plus the hooks a test needs to drive it: mutation callbacks, frame
// callbacks, the deadline timer, and a count of how many full walks ran.
function makePage(body) {
  const state = {
    walks: 0,
    observers: [],
    frames: [],
    timers: [],
    body,
  };

  const sandbox = {
    document: {
      get body() {
        return state.body;
      },
      createTreeWalker(root) {
        state.walks++;
        const nodes = root ? textNodesUnder(root) : [];
        let i = 0;
        return { nextNode: () => (i < nodes.length ? nodes[i++] : null) };
      },
    },
    NodeFilter: { SHOW_TEXT: 4 },
    window: {},
    MutationObserver: function (callback) {
      const observer = {
        callback,
        options: null,
        connected: false,
        observe(target, options) {
          this.options = options;
          this.connected = true;
        },
        disconnect() {
          this.connected = false;
        },
      };
      state.observers.push(observer);
      return observer;
    },
    requestAnimationFrame(callback) {
      state.frames.push(callback);
    },
    setTimeout(callback, ms) {
      state.timers.push({ callback, ms });
    },
  };

  vm.createContext(sandbox);
  state.sandbox = sandbox;
  state.run = () => vm.runInContext(buildScript(), sandbox);
  state.flushFrames = () => {
    const pending = state.frames.splice(0);
    for (const frame of pending) frame();
  };
  return state;
}

const STRUCK_MAC = 'M̶a̶c̶';

function welcomeHeading() {
  const mac = text('Mac');
  const heading = elem([text('Claude for '), mac]);
  return { body: elem([heading]), mac };
}

// ── Output ──────────────────────────────────────────────────────────────────

test('rewrites the heading text node to a struck Mac plus Linux', () => {
  const { body, mac } = welcomeHeading();
  const page = makePage(body);
  page.run();
  assert.equal(mac.nodeValue, STRUCK_MAC + ' Linux');
});

test('leaves a bare "Mac" alone when no ancestor reads "Claude for Mac"', () => {
  const mac = text('Mac');
  const page = makePage(elem([elem([text('Made on a '), mac])]));
  page.run();
  assert.equal(mac.nodeValue, 'Mac', 'only the welcome heading may be rewritten');
});

// ── Cost ────────────────────────────────────────────────────────────────────

test('a heading present on the first pass leaves no observer running', () => {
  const { body } = welcomeHeading();
  const page = makePage(body);
  page.run();
  assert.equal(page.observers.length, 0, 'nothing to watch for once the rewrite landed');
  assert.equal(page.sandbox.window.__coworkMacLinuxObserver, undefined);
});

test('the observer never subscribes to characterData', () => {
  const page = makePage(elem([text('signed in, no heading here')]));
  page.run();
  assert.equal(page.observers.length, 1);
  const { options } = page.observers[0];
  assert.equal(options.childList, true);
  assert.equal(options.subtree, true);
  assert.ok(
    !options.characterData,
    'characterData + subtree means a full-document walk per streamed token'
  );
});

test('a burst of mutations coalesces into one walk per frame', () => {
  const page = makePage(elem([text('no heading yet')]));
  page.run();
  const walksAfterFirstPass = page.walks;
  const observer = page.observers[0];

  for (let i = 0; i < 25; i++) observer.callback([], observer);
  assert.equal(page.walks, walksAfterFirstPass, 'no walk until the frame runs');

  page.flushFrames();
  assert.equal(page.walks, walksAfterFirstPass + 1, '25 records must cost one walk, not 25');
});

test('a heading that arrives later is rewritten, then the observer stops', () => {
  const page = makePage(elem([text('no heading yet')]));
  page.run();
  const observer = page.observers[0];
  assert.equal(observer.connected, true);

  const { body, mac } = welcomeHeading();
  page.body = body;
  observer.callback([], observer);
  page.flushFrames();

  assert.equal(mac.nodeValue, STRUCK_MAC + ' Linux');
  assert.equal(observer.connected, false, 'must disconnect once the rewrite lands');
  assert.equal(page.sandbox.window.__coworkMacLinuxObserver, null);
});

test('the deadline disconnects an observer on a page that never shows the heading', () => {
  const page = makePage(elem([text('a signed-in session, forever')]));
  page.run();
  const observer = page.observers[0];
  assert.equal(observer.connected, true);

  assert.equal(page.timers.length, 1, 'a deadline must be armed');
  assert.ok(page.timers[0].ms > 0 && page.timers[0].ms <= 60000,
    'deadline should be seconds, not unbounded: ' + page.timers[0].ms);
  page.timers[0].callback();

  assert.equal(observer.connected, false);
  assert.equal(page.sandbox.window.__coworkMacLinuxObserver, null);
});

test('a stale deadline cannot disconnect a later navigation observer', () => {
  const page = makePage(elem([text('first navigation')]));
  page.run();
  const first = page.observers[0];
  const firstDeadline = page.timers[0].callback;

  first.disconnect();
  page.sandbox.window.__coworkMacLinuxObserver = null;
  page.run();
  const second = page.observers[1];
  assert.equal(second.connected, true);

  firstDeadline();
  assert.equal(second.connected, true, 'the old timer must not release the new observer');
  assert.equal(page.sandbox.window.__coworkMacLinuxObserver, second);
});

// ── Robustness ──────────────────────────────────────────────────────────────

test('a document with no body is a no-op, not a throw', () => {
  const page = makePage(null);
  assert.doesNotThrow(() => page.run());
  assert.equal(page.observers.length, 0);
});

test('re-injecting on the same page does not stack observers', () => {
  const page = makePage(elem([text('no heading')]));
  page.run();
  page.run();
  page.run();
  const connected = page.observers.filter((o) => o.connected);
  assert.equal(connected.length, 1, 'dom-ready and did-navigate both inject; only one may observe');
});
