'use strict';

// Enumerates the commands the user has declared as MCP servers, so the exec
// capability registry can admit those specific binaries instead of admitting
// every file that happens to sit in a user-writable directory.
//
// Why this exists: USER_MCP_PREFIXES allowlisted *locations* (~/.local/bin and
// friends). That is an allowlist in form only -- a location list is unbounded in
// what it permits, since the user can put anything there and package managers
// symlink out of it into directories the list never mentions. The authority we
// actually want is the user's own declaration: an MCP server they configured is
// a command they intended to run, named explicitly, in a file they own.
//
// Sources enumerated (all four are read by the asar itself):
//   1. $XDG_CONFIG_HOME/Claude/claude_desktop_config.json  -> mcpServers
//   2. $CLAUDE_CONFIG_DIR|$HOME/.claude.json               -> mcpServers
//   3. the same file's projects[<root>].mcpServers         -> per-project servers
//   4. <root>/.mcp.json for each of those roots            -> mcpServers, or the
//                                                             bare map
//
// KNOWN GAP: the bundle also lets plugins point at MCP config files at arbitrary
// paths, and those are not enumerated here. A server declared only that way is
// refused. That refusal is loud and names the binary (see the registry's BLOCKED
// message) rather than failing as a silent disconnect, but it is a real gap --
// the same coverage objection that applies to any config-derived allowlist.
// Widening this means adding sources here, never falling back to location.

const fs = require('fs');
const path = require('path');

function parseJsonFile(readFileSync, filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (_) {
    // Missing, unreadable, or malformed -- contributes nothing.
    return null;
  }
}

function commandsFromServerMap(servers, sink) {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  for (var key in servers) {
    if (!Object.prototype.hasOwnProperty.call(servers, key)) continue;
    var entry = servers[key];
    if (entry && typeof entry.command === 'string' && entry.command.length > 0) {
      sink.push(entry.command);
    }
  }
}

function createUserMcpAllowlist({
  homedir,
  env = process.env,
  readFileSync = fs.readFileSync,
  statSync = fs.statSync,
  realpathSync = fs.realpathSync,
} = {}) {
  var home = homedir;
  try { home = realpathSync(homedir); } catch (_) {}

  function primarySources() {
    var xdgConfigHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
    var claudeConfigDir = env.CLAUDE_CONFIG_DIR || home;
    return [
      path.join(xdgConfigHome, 'Claude', 'claude_desktop_config.json'),
      path.join(claudeConfigDir, '.claude.json'),
    ];
  }

  // Bare commands ("npx", "node", "uvx") are extremely common in MCP configs, so
  // a declaration has to be resolved the way a shell would before it can be
  // compared against a spawn path. First match in PATH order wins, matching
  // execvp, rather than admitting every PATH directory's copy.
  function resolveDeclared(command) {
    if (command.indexOf('/') >= 0) {
      return path.isAbsolute(command) ? [command] : [];
    }
    var pathEnv = typeof env.PATH === 'string' ? env.PATH : '';
    var dirs = pathEnv.split(path.delimiter).filter(Boolean);
    for (var i = 0; i < dirs.length; i++) {
      var candidate = path.join(dirs[i], command);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return [candidate];
      } catch (_) { /* keep looking */ }
    }
    return [];
  }

  function collect() {
    var declared = [];
    var sources = primarySources();

    for (var i = 0; i < sources.length; i++) {
      var parsed = parseJsonFile(readFileSync, sources[i]);
      if (!parsed) continue;
      commandsFromServerMap(parsed.mcpServers, declared);

      var projects = parsed.projects;
      if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
        for (var root in projects) {
          if (!Object.prototype.hasOwnProperty.call(projects, root)) continue;
          var project = projects[root];
          if (project) commandsFromServerMap(project.mcpServers, declared);
          if (!path.isAbsolute(root)) continue;
          // <root>/.mcp.json accepts either {mcpServers:{...}} or the bare map.
          var projectConfig = parseJsonFile(readFileSync, path.join(root, '.mcp.json'));
          if (projectConfig) {
            commandsFromServerMap(projectConfig.mcpServers || projectConfig, declared);
          }
        }
      }
    }

    var allowed = new Set();
    for (var d = 0; d < declared.length; d++) {
      var candidates = resolveDeclared(declared[d]);
      for (var c = 0; c < candidates.length; c++) {
        var candidate = candidates[c];
        allowed.add(candidate);
        // Also admit the realpath, so a declaration naming the shim still
        // matches a spawn naming the target (and vice versa). Both spellings
        // name the same file, so this adds no reach.
        try {
          var real = realpathSync(candidate);
          if (real) allowed.add(real);
        } catch (_) { /* dangling declaration contributes only its literal path */ }
      }
    }
    return allowed;
  }

  // Recompute when any source file changes. Spawns are infrequent enough that a
  // stat per source beats a TTL that could serve a stale answer after the user
  // edits their config and retries.
  var _cache = null;
  var _fingerprint = null;

  function fingerprint() {
    var parts = [];
    var sources = primarySources();
    for (var i = 0; i < sources.length; i++) {
      try {
        var st = statSync(sources[i]);
        parts.push(sources[i] + ':' + st.mtimeMs + ':' + st.size);
      } catch (_) {
        parts.push(sources[i] + ':absent');
      }
    }
    return parts.join('|');
  }

  function current() {
    var fp = fingerprint();
    if (_cache === null || fp !== _fingerprint) {
      _cache = collect();
      _fingerprint = fp;
    }
    return _cache;
  }

  return Object.freeze({
    has: function (candidatePath) {
      if (typeof candidatePath !== 'string' || candidatePath.length === 0) return false;
      return current().has(candidatePath);
    },
    snapshot: function () {
      return Array.from(current()).sort();
    },
    invalidate: function () {
      _cache = null;
      _fingerprint = null;
    },
  });
}

module.exports = Object.freeze({
  createUserMcpAllowlist: createUserMcpAllowlist,
});
