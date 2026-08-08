'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function existsExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// Syntactic validation only: absolute, no NUL, no empty/./.. segments. Returns
// the path unchanged, or null. Split out of realpathSafe so a caller can ask
// "is this path well-formed?" without following symlinks -- classification
// sometimes needs the path as written, not where it lands (see resolve()).
function lexicalSafe(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  if (p.charCodeAt(0) !== 47) return null;
  if (p.indexOf('\0') >= 0) return null;
  var segs = p.split('/');
  for (var i = 1; i < segs.length; i++) {
    if (segs[i] === '' || segs[i] === '.' || segs[i] === '..') return null;
  }
  return p;
}

function realpathSafe(p) {
  if (lexicalSafe(p) === null) return null;
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return null;
  }
}

function createExecCapabilityRegistry({
  homedir = os.userInfo().homedir,
  resolveClaudeBinaryPath = null,
} = {}) {
  var home;
  try { home = fs.realpathSync(homedir); } catch (e) {
    console.warn('[exec-capability] homedir realpath failed, using raw path: ' + (e && e.message));
    home = homedir;
  }

  var SYSTEM_PATHS = Object.freeze({
    git:          Object.freeze(['/usr/bin/git', '/usr/local/bin/git']),
    bash:         Object.freeze(['/usr/bin/bash', '/bin/bash']),
    'xdg-open':   Object.freeze(['/usr/bin/xdg-open']),
    'xdg-mime':   Object.freeze(['/usr/bin/xdg-mime', '/usr/local/bin/xdg-mime']),
    which:        Object.freeze(['/usr/bin/which']),
    curl:         Object.freeze(['/usr/bin/curl', '/usr/local/bin/curl']),
    'notify-send':Object.freeze(['/usr/bin/notify-send']),
    gdbus:        Object.freeze(['/usr/bin/gdbus']),
  });

  var systemPathIndex = new Map();
  for (var name in SYSTEM_PATHS) {
    var paths = SYSTEM_PATHS[name];
    for (var pi = 0; pi < paths.length; pi++) {
      systemPathIndex.set(paths[pi], 'system-' + name);
    }
  }

  var USER_MCP_PREFIXES = Object.freeze([
    home + '/.local/bin/',
    home + '/.npm-global/bin/',
    home + '/.cargo/bin/',
    home + '/go/bin/',
    home + '/.bun/bin/',
    home + '/.deno/bin/',
    home + '/.local/share/mise/shims/',
    home + '/.asdf/shims/',
    home + '/.volta/bin/',
    home + '/bin/',
  ]);

  var SYSTEM_CMD_PREFIXES = Object.freeze([
    '/usr/bin/',
    '/usr/local/bin/',
    '/usr/lib/',
    '/snap/bin/',
  ]);

  var CLAUDE_SEARCH_PATHS = Object.freeze([
    home + '/.local/bin/claude',
    home + '/.local/share/mise/shims/claude',
    home + '/.asdf/shims/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]);

  var _claudeBinaryCache = undefined;

  function resolveClaudeCli() {
    if (_claudeBinaryCache !== undefined) return _claudeBinaryCache;
    if (typeof resolveClaudeBinaryPath === 'function') {
      var result = resolveClaudeBinaryPath();
      if (result) { _claudeBinaryCache = result; return result; }
    }
    for (var ci = 0; ci < CLAUDE_SEARCH_PATHS.length; ci++) {
      if (existsExecutable(CLAUDE_SEARCH_PATHS[ci])) {
        _claudeBinaryCache = CLAUDE_SEARCH_PATHS[ci];
        return _claudeBinaryCache;
      }
    }
    _claudeBinaryCache = null;
    return null;
  }

  function underUserPrefix(p) {
    if (!p) return false;
    for (var i = 0; i < USER_MCP_PREFIXES.length; i++) {
      if (p.startsWith(USER_MCP_PREFIXES[i])) return true;
    }
    return false;
  }

  function resolve(binaryPath, args) {
    if (typeof binaryPath !== 'string' || binaryPath.length === 0) return null;

    var lexical = lexicalSafe(binaryPath);
    var real = realpathSafe(binaryPath);

    var claudePath = resolveClaudeCli();
    if (claudePath && (binaryPath === claudePath || real === claudePath)) {
      return { capabilityId: 'claude-cli', cmd: claudePath, args: args || [] };
    }

    if (real) {
      var sysId = systemPathIndex.get(real);
      if (sysId) {
        return { capabilityId: sysId, cmd: real, args: args || [] };
      }
    }

    if (!real) {
      console.warn('[exec-capability] BLOCKED (unresolvable): ' + binaryPath);
      return null;
    }

    for (var si = 0; si < SYSTEM_CMD_PREFIXES.length; si++) {
      if (real.startsWith(SYSTEM_CMD_PREFIXES[si])) {
        return { capabilityId: 'system-cmd', cmd: real, args: args || [] };
      }
    }

    // user-mcp: a binary the user installed under their own home. Classified on
    // the requested path OR its realpath, because package- and version-manager
    // shims symlink out of `bin/` into a versioned lib/ or venv directory --
    // npm-global lands in lib/node_modules/, and nvm, pipx, pnpm and volta each
    // land somewhere different again. Resolving first walked all of those out of
    // every prefix, so a legitimately configured MCP server read as unresolvable
    // (#164). Enumerating the landing directories would only chase that list.
    //
    // This is a deliberate widening, not a no-op. A shim under a user prefix now
    // resolves even when its target lies outside every prefix -- exactly the
    // npm-global case, and blocked before. It hands an attacker no capability
    // they lacked, because write access to a user prefix already admitted an
    // executable dropped there directly; a symlink is a slower way to do what a
    // plain file already did. What it does not touch is the system classes:
    // those are still matched on the realpath above, so a user symlink cannot
    // masquerade as /usr/bin/git.
    if (underUserPrefix(lexical)) {
      // Spawn the shim the user configured rather than its realpath: argv[0] and
      // any wrapper semantics belong to the shim, and the realpath is a path the
      // user never named. Executability is identical either way -- access(X_OK)
      // follows symlinks -- so this is about intent, not about the exec bit.
      return { capabilityId: 'user-mcp', cmd: lexical, args: args || [] };
    }
    if (underUserPrefix(real)) {
      return { capabilityId: 'user-mcp', cmd: real, args: args || [] };
    }

    console.warn('[exec-capability] BLOCKED: ' + binaryPath);
    return null;
  }

  var CAPABILITY_LABELS = Object.freeze({
    bash: 'Bash shell', git: 'Git',
    'xdg-open': 'XDG open', 'xdg-mime': 'XDG MIME query',
    which: 'which', curl: 'curl',
    'notify-send': 'notify-send', gdbus: 'D-Bus client',
  });

  function resolveCapability(id) {
    if (id === 'claude-cli') {
      var p = resolveClaudeCli();
      return p ? { exec: p, label: 'Claude Code CLI' } : null;
    }
    var name = typeof id === 'string' && id.startsWith('system-') ? id.slice(7) : null;
    if (name && SYSTEM_PATHS[name]) {
      var paths = SYSTEM_PATHS[name];
      for (var i = 0; i < paths.length; i++) {
        if (existsExecutable(paths[i])) return { exec: paths[i], label: CAPABILITY_LABELS[name] || name };
      }
    }
    return null;
  }

  // The disclaimer wrapper is a macOS platform adapter, not a policy layer. In
  // the asar it is one function -- `platform!=="darwin" ? cmd : {cmd:disclaimer,
  // args:[cmd,...]}` -- whose non-darwin branch returns the command untouched;
  // on macOS the wrapper disclaims TCC responsibility and execs. We only meet it
  // because we spoof darwin. launch.sh patches that branch back to the identity
  // it already is on Linux, so this unwrap is the fallback for builds where the
  // patch doesn't match.
  //
  // It therefore TRANSLATES macOS-shaped paths and DELEGATES admission to
  // resolve() -- the one admission rule, shared with the process-spawn path in
  // session_orchestrator. It holds no policy of its own. A carve-out here is
  // what blocked the Claude CLI in #132 and every user-installed MCP server in
  // #164: the wrapper's caller set is "whatever the bundle routes through it",
  // which no allowlist maintained here can stay ahead of.
  function resolveDisclaimerCommand(args) {
    if (!Array.isArray(args) || args.length === 0) return null;
    var cmd = args[0];
    var rest = args.slice(1);
    // The asar invokes the Claude CLI through the disclaimer wrapper using
    // whatever path it chose -- a macOS-style claude.app/.../Claude path, or
    // the SDK path it installed (claude-code-vm/<ver>/claude), or a native
    // ~/.local/bin/claude. The OCap rewrite (f41417e) only matched the .app
    // path and rejected everything else as user-mcp, so any other Claude path
    // fell through and the disclaimer stub (exit 127) ran instead -- see #132.
    // Recognise the Claude CLI by basename and map it to OUR resolved binary
    // (never the caller's path), so this adds no privilege the caller lacks.
    if (typeof cmd === 'string' &&
        (/claude\.app\/Contents\/MacOS\/[Cc]laude$/.test(cmd) ||
         path.basename(cmd) === 'claude')) {
      var claudePath = resolveClaudeCli();
      return claudePath ? { cmd: claudePath, rest: rest } : null;
    }
    var resolved = resolve(cmd, rest);
    return resolved ? { cmd: resolved.cmd, rest: rest } : null;
  }

  function invalidateClaudeCache() {
    _claudeBinaryCache = undefined;
  }

  return Object.freeze({
    resolve: resolve,
    resolveCapability: resolveCapability,
    resolveDisclaimerCommand: resolveDisclaimerCommand,
    invalidateClaudeCache: invalidateClaudeCache,
    SYSTEM_PATHS: SYSTEM_PATHS,
    USER_MCP_PREFIXES: USER_MCP_PREFIXES,
    SYSTEM_CMD_PREFIXES: SYSTEM_CMD_PREFIXES,
  });
}

module.exports = Object.freeze({
  createExecCapabilityRegistry: createExecCapabilityRegistry,
  lexicalSafe: lexicalSafe,
  realpathSafe: realpathSafe,
  existsExecutable: existsExecutable,
});
