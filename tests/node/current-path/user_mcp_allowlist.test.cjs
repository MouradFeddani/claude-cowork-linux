'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserMcpAllowlist } = require(
  path.resolve(__dirname, '../../../stubs/cowork/user_mcp_allowlist.js')
);

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-allowlist-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const env = {
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CLAUDE_CONFIG_DIR: home,
    PATH: binDir,
  };
  const writeConfig = (mcpServers) => {
    const dir = path.join(home, '.config', 'Claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude_desktop_config.json'), JSON.stringify({ mcpServers }), 'utf8');
  };
  return { home, binDir, env, writeConfig, make: () => createUserMcpAllowlist({ homedir: home, env }) };
}

describe('user_mcp_allowlist', () => {
  // The common shape in real MCP configs is a bare command -- "npx", "node",
  // "uvx" -- not an absolute path, so a declaration has to be resolved the way
  // a shell would before it can be compared against a spawn path.
  it('resolves a bare command through PATH', (t) => {
    const f = fixture(t);
    const npx = path.join(f.binDir, 'npx');
    fs.writeFileSync(npx, '#!/bin/sh\n', { mode: 0o755 });
    f.writeConfig({ fs: { command: 'npx', args: ['-y', 'server-filesystem'] } });
    assert.ok(f.make().has(npx));
  });

  it('takes the first PATH match, as execvp would', (t) => {
    const f = fixture(t);
    const second = path.join(f.home, 'bin2');
    fs.mkdirSync(second, { recursive: true });
    const first = path.join(f.binDir, 'tool');
    const shadowed = path.join(second, 'tool');
    fs.writeFileSync(first, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(shadowed, '#!/bin/sh\n', { mode: 0o755 });
    const allow = createUserMcpAllowlist({
      homedir: f.home,
      env: { ...f.env, PATH: [f.binDir, second].join(path.delimiter) },
    });
    f.writeConfig({ t: { command: 'tool' } });
    assert.ok(allow.has(first), 'the PATH entry that would actually run is admitted');
    assert.ok(!allow.has(shadowed), 'a shadowed copy elsewhere in PATH is not');
  });

  it('ignores a bare command that is not on PATH', (t) => {
    const f = fixture(t);
    f.writeConfig({ ghost: { command: 'not-installed-anywhere' } });
    assert.deepStrictEqual(f.make().snapshot(), []);
  });

  it('does not admit a relative command', (t) => {
    const f = fixture(t);
    f.writeConfig({ rel: { command: './sneaky' } });
    assert.deepStrictEqual(f.make().snapshot(), []);
  });

  it('admits both spellings of an absolute declaration', (t) => {
    const f = fixture(t);
    const target = path.join(f.home, 'lib', 'server.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/usr/bin/env node\n', { mode: 0o755 });
    const shim = path.join(f.binDir, 'srv');
    fs.symlinkSync(target, shim);
    f.writeConfig({ srv: { command: shim } });
    const allow = f.make();
    assert.ok(allow.has(shim), 'the declared spelling');
    assert.ok(allow.has(target), 'and its realpath, which names the same file');
  });

  it('tolerates malformed and missing config without admitting anything', (t) => {
    const f = fixture(t);
    const dir = path.join(f.home, '.config', 'Claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude_desktop_config.json'), '{ not json', 'utf8');
    assert.deepStrictEqual(f.make().snapshot(), [],
      'a broken config must fail closed, not throw and not open up');
  });

  it('ignores entries with no command', (t) => {
    const f = fixture(t);
    f.writeConfig({ broken: { args: ['--x'] }, alsoBroken: { command: 42 } });
    assert.deepStrictEqual(f.make().snapshot(), []);
  });
});
