'use strict';

// Coverage for the Linux @ant/claude-native "safe-fs containment" API added
// for asar 1.22209.x (openRootDir + *Beneath). Verifies the round-trip works
// (delegating byte I/O to Node FileHandles) and that containment is fail-closed
// against separator / '..' / symlink escapes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const safeFs = require('../../../stubs/@ant/claude-native/safe_fs.js');

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

test('openRootDir returns a canonical handle; rejects missing dir and files', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);
  assert.equal(h.__safeRoot, root);
  assert.equal(typeof h.close, 'function');
  await h.close();

  await assert.rejects(() => safeFs.openRootDir(path.join(root, 'nope')));
  const f = path.join(root, 'file');
  fs.writeFileSync(f, 'x');
  await assert.rejects(() => safeFs.openRootDir(f), /not a directory/);
  await assert.rejects(() => safeFs.openRootDir('relative/path'));
});

test('mkdir/open/write/read/rename/unlink round-trip beneath the root', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);

  await safeFs.mkdirBeneath(h, ['sub'], { recursive: true });
  assert.ok(fs.statSync(path.join(root, 'sub')).isDirectory());

  // openBeneath returns a Node FileHandle: write then read with the exact
  // (buffer, offset, length, position) signature the caller uses.
  const fh = await safeFs.openBeneath(h, ['sub', 'a.txt'], 'w+', 0o600);
  await fh.write(Buffer.from('hello world'), 0, 11, 0);
  const buf = Buffer.alloc(11);
  await fh.read(buf, 0, 11, 0);
  assert.equal(buf.toString('utf8'), 'hello world');
  const st = await fh.stat();
  assert.equal(st.size, 11);
  await fh.close();

  await safeFs.renameBeneath(h, ['sub', 'a.txt'], ['sub', 'b.txt']);
  assert.ok(fs.existsSync(path.join(root, 'sub', 'b.txt')));
  assert.ok(!fs.existsSync(path.join(root, 'sub', 'a.txt')));

  await safeFs.unlinkBeneath(h, ['sub', 'b.txt']);
  assert.ok(!fs.existsSync(path.join(root, 'sub', 'b.txt')));
});

test('containment is fail-closed: separators, dotdot, and symlink escape are denied', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);

  const denied = (p) => assert.rejects(p, (e) => e.code === 'EACCES');

  await denied(() => safeFs.mkdirBeneath(h, ['..'], {}));
  await denied(() => safeFs.mkdirBeneath(h, ['a/b'], {}));           // embedded separator
  await denied(() => safeFs.openBeneath(h, ['..', 'etc'], 'r'));
  await denied(() => safeFs.unlinkBeneath(h, ['\0evil']));

  // A missing handle is rejected too.
  await denied(() => safeFs.mkdirBeneath(null, ['x'], {}));

  // Symlink escape: root/link -> outside; writing beneath it must be denied.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'safefs-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'link'));
  await denied(() => safeFs.openBeneath(h, ['link', 'pwned'], 'w'));
  assert.ok(!fs.existsSync(path.join(outside, 'pwned')), 'nothing may be written outside the root');
});

// Regression: a DANGLING symlink at the final component escaped the root.
// existsSync() is false for a broken link, so the nearest-existing-ancestor
// realpath walk skipped past it to the legitimate parent and the check passed —
// then open('w') followed the link and created the file at its target outside
// the root. O_NOFOLLOW on the final component closes it.
test('a dangling symlink at the final component cannot escape the root', async (t) => {
  const root = tmpRoot(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safefs-dangle-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const h = await safeFs.openRootDir(root);

  // root/dangle -> outside/pwned, which does NOT exist yet.
  fs.symlinkSync(path.join(outside, 'pwned'), path.join(root, 'dangle'));
  await assert.rejects(() => safeFs.openBeneath(h, ['dangle'], 'w'), (e) => e.code === 'EACCES');
  assert.ok(!fs.existsSync(path.join(outside, 'pwned')),
    'a write through a dangling symlink must not create a file outside the root');

  // Same for the read-write and append creation modes.
  for (const flag of ['w+', 'a', 'a+']) {
    await assert.rejects(() => safeFs.openBeneath(h, ['dangle'], flag), (e) => e.code === 'EACCES');
  }
  assert.ok(!fs.existsSync(path.join(outside, 'pwned')), 'still nothing outside the root');
});

// Native RESOLVE_BENEATH permits symlinks that stay inside the root, so a
// link to a sibling file beneath the root must keep working.
test('a symlink that stays inside the root is still usable', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);

  fs.writeFileSync(path.join(root, 'real.txt'), 'inside');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));

  const fh = await safeFs.openBeneath(h, ['alias.txt'], 'r');
  const buf = Buffer.alloc(6);
  await fh.read(buf, 0, 6, 0);
  await fh.close();
  assert.equal(buf.toString('utf8'), 'inside');
});

test('unsupported open flags are rejected rather than opened without O_NOFOLLOW', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);
  await assert.rejects(() => safeFs.openBeneath(h, ['x.txt'], 'bogus'), (e) => e.code === 'EACCES');
  // Numeric flags pass through (the caller may hand us raw O_* bits).
  const fh = await safeFs.openBeneath(h, ['n.txt'], fs.constants.O_CREAT | fs.constants.O_RDWR);
  await fh.close();
  assert.ok(fs.existsSync(path.join(root, 'n.txt')));
});
