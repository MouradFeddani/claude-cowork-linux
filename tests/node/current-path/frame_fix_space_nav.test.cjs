'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Extract the pure space-navigation helpers from frame-fix-wrapper.js and run
// them in an isolated vm context. These functions have no closure dependencies,
// so we can slice from the first helper to the IPC TAP section and evaluate it.
function loadSpaceNavHelpers() {
  const wrapperPath = path.join(
    __dirname, '..', '..', '..', 'stubs', 'frame-fix', 'frame-fix-wrapper.js'
  );
  const source = fs.readFileSync(wrapperPath, 'utf8');
  const start = source.indexOf('function shouldInterceptSpaceNavigation');
  const end = source.indexOf('// IPC TAP — must be created before the early ipcMain patch');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to locate space-nav helper block in ' + wrapperPath);
  }
  const block = source.slice(start, end);
  const context = {
    URL, // provided from this realm — vm contexts don't include URL by default
    JSON,
    console: { log() {}, error() {} },
  };
  vm.createContext(context);
  vm.runInContext(block, context, { filename: path.basename(wrapperPath) });
  return context;
}

const helpers = loadSpaceNavHelpers();
const { shouldInterceptSpaceNavigation, coworkSpaceRoute, buildSpaNavigationScript } = helpers;

test('intercepts an in-app navigation to a locally-created space', () => {
  assert.equal(
    shouldInterceptSpaceNavigation(
      'https://claude.ai/cowork',
      'https://claude.ai/cowork/space/100750d9-4cfa-4248-909e-0c87b64f0a54'
    ),
    true
  );
});

test('intercepts with query/fragment on the space route', () => {
  assert.equal(
    shouldInterceptSpaceNavigation(
      'https://claude.ai/cowork/space/aaa',
      'https://claude.ai/cowork/space/bbb?tab=files#top'
    ),
    true
  );
});

test('does NOT intercept the initial/hard load (SPA not yet on claude.ai)', () => {
  assert.equal(
    shouldInterceptSpaceNavigation(
      'about:blank',
      'https://claude.ai/cowork/space/abc'
    ),
    false
  );
});

test('does NOT intercept auth/external hosts', () => {
  assert.equal(
    shouldInterceptSpaceNavigation(
      'https://claude.ai/cowork',
      'https://auth.anthropic.com/oauth?next=/cowork/space/abc'
    ),
    false
  );
  // current host is not claude.ai -> real navigation must proceed untouched
  assert.equal(
    shouldInterceptSpaceNavigation(
      'https://evil.example/cowork/space/abc',
      'https://claude.ai/cowork/space/abc'
    ),
    false
  );
});

test('does NOT intercept non-space cowork routes', () => {
  assert.equal(
    shouldInterceptSpaceNavigation(
      'https://claude.ai/cowork',
      'https://claude.ai/cowork/settings'
    ),
    false
  );
  // /cowork/space with no id is not a specific space
  assert.equal(
    shouldInterceptSpaceNavigation(
      'https://claude.ai/cowork',
      'https://claude.ai/cowork/space/'
    ),
    false
  );
});

test('does NOT intercept a no-op navigation to the same route', () => {
  assert.equal(
    shouldInterceptSpaceNavigation(
      'https://claude.ai/cowork/space/abc',
      'https://claude.ai/cowork/space/abc'
    ),
    false
  );
});

test('does NOT intercept http (non-https) targets', () => {
  assert.equal(
    shouldInterceptSpaceNavigation(
      'https://claude.ai/cowork',
      'http://claude.ai/cowork/space/abc'
    ),
    false
  );
});

test('returns false on unparseable urls instead of throwing', () => {
  assert.equal(shouldInterceptSpaceNavigation('not a url', 'also not'), false);
  assert.equal(shouldInterceptSpaceNavigation(null, undefined), false);
});

test('coworkSpaceRoute returns path + query + fragment', () => {
  assert.equal(
    coworkSpaceRoute('https://claude.ai/cowork/space/abc?tab=files#top'),
    '/cowork/space/abc?tab=files#top'
  );
  assert.equal(coworkSpaceRoute('::::not a url'), null);
});

test('buildSpaNavigationScript JSON-encodes the route (injection-safe)', () => {
  const script = buildSpaNavigationScript('/cowork/space/abc');
  assert.match(script, /history\.pushState/);
  assert.match(script, /popstate/);
  assert.match(script, /"\/cowork\/space\/abc"/);

  // A hostile route containing a quote + script terminator must stay a string
  // literal, never break out into executable code.
  const hostile = '/cowork/space/x";alert(1);//';
  const hostileScript = buildSpaNavigationScript(hostile);
  // The route must appear only as a JSON-encoded string literal, and the
  // generated script must itself be syntactically valid JS — so a hostile
  // route cannot break out of the string into executable code.
  assert.ok(hostileScript.includes(JSON.stringify(hostile)));
  assert.doesNotThrow(() => new vm.Script(hostileScript));
});
