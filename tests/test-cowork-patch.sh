#!/bin/bash
#
# Regression tests for the Cowork patch machinery.
#
# Claude Desktop's main bundle is minified, and two things change every build:
#   1. the minifier reassigns short identifiers (the IPC sender arg was `i` in
#      older builds and is `n` now; validators can even contain `$`);
#   2. newer builds split the Vite main entry so index.js becomes a thin shim
#      that require()s the real code from an index.chunk-<hash>.js file.
#
# These tests pin both behaviours so a future build reshuffle can't silently
# turn the patches into no-ops:
#   - enable-cowork.py patches a chunk whose identifiers differ from anything
#     hardcoded (platform gate, IPC origin guards, host-platform, return gate);
#   - the index.js -> index.chunk discovery used by install.sh / launch.sh finds
#     the chunk from the shim, and is a clean no-op on single-entry builds;
#   - launch.sh's patch_index seds apply across a chunk with rotated identifiers.
#
# No network or Docker needed. Requires python3 and node.
#
#   ./tests/test-cowork-patch.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0; SKIP=0
pass() { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL + 1)); }
skip() { echo -e "  ${YELLOW}SKIP${NC} $*"; SKIP=$((SKIP + 1)); }
section() { echo -e "\n${BOLD}=== $* ===${NC}"; }

HAVE_NODE=0
command -v node >/dev/null 2>&1 && HAVE_NODE=1

# assert_grep <file> <ERE pattern> <label>   — pattern MUST be present
assert_grep() { if grep -qE "$2" "$1"; then pass "$3"; else fail "$3"; fi; }
# refute_grep <file> <ERE pattern> <label>   — pattern must be ABSENT
refute_grep() { if grep -qE "$2" "$1"; then fail "$3"; else pass "$3"; fi; }
# assert_parses <file> <label>
assert_parses() {
  if [[ "$HAVE_NODE" -eq 0 ]]; then skip "$2 (node not installed)"; return; fi
  if node --check "$1" 2>/dev/null; then pass "$2"; else fail "$2 (node --check failed)"; fi
}

# The exact discovery used by install.sh apply_patches and launch.sh: glob the
# build dir, don't follow the shim's require()s. Chunks require() each other
# transitively, so the shim names only a subset (131 of 333 on 1.26832.0), and
# a second index2.chunk-* series now carries the platform gate. Takes the build
# directory, not the shim, so it mirrors the shipped mechanism.
discover_chunks() { find "$1" -maxdepth 1 -name 'index*.chunk-*.js' -type f -printf '%f\n' 2>/dev/null | sort; }

# Write a chunk exercising every patch site, using identifiers that are NOT the
# values any older hardcoded pattern used (function qZ9/var r; validator $m/arg
# n; objects Zq/Yw/Xp/mB/kk/jn; setUserActivity arg qq).
write_patch_fixture() {
  cat > "$1" <<'EOF'
"use strict";
function qZ9(){const r=process.platform;if(r!=="darwin"&&r!=="win32")return{status:"unsupported",reason:"nope"};return{status:"supported"}}
const gate=qZ9();
function checkOrigin(n){if(!$m(n))throw new Error(`Incoming "doThing" call on interface "MyIface" from '${(i=n.senderFrame)==null?void 0:i.url}' did not pass origin validation`)}
function hostPlat(){if(process.platform==="darwin")return"darwin-x64";throw new Error("Unsupported platform: "+process.platform)}
function extInstall(){return{status:2,error:`Unsupported platform: ${process.platform} not allowed`}}
const winOpts={show:!1,titleBarStyle:"hidden",titleBarOverlay:Ab,trafficLightPosition:Cd,webPreferences:{}};
const aboutOpts={titleBarStyle:"hiddenInset",autoHideMenuBar:!0,skipTaskbar:!0};
function guard(){return Zq.protocol==="file:"&&Yw.app.isPackaged===!0}
function buildArgs(){Xp.push("--effort",this.options.effort)}
function handoff(){mB.app.invalidateCurrentActivity();mB.app.setUserActivity(qq,{})}
function wrapSpawn(t){return process.platform!=="darwin"?t:{cmd:rpt(),args:[t.cmd,...t.args]}}
const res=kk.app.isPackaged?process.resourcesPath:someFallback;
const host=kk.app.isPackaged?jn.join(process.resourcesPath,"app.asar","mcp-runtime","nodeHost.js"):jn.join(kk.app.getAppPath(),"nodeHost.js");
EOF
}

# Same sites as write_patch_fixture, in the shapes 1.26832.0 actually emits.
# This is the regression that motivated #166 and it is invisible to a
# double-quoted fixture: the minifier moved to backtick template literals, so
# every pattern anchored on `"` missed and EVERY patch silently no-opped while
# install.sh still reported success. Without this fixture someone can re-narrow
# ["`] back to " tomorrow and the suite stays green.
#
# Also covers the smaller shape changes that landed with it: `let` instead of
# `const` in the gate, a bare `throw Error(` instead of `throw new Error(`, and
# minified values that gained dots and negations (r.default, !1) where the old
# patterns assumed [A-Za-z0-9_$]+.
write_patch_fixture_backtick() {
  cat > "$1" <<'EOF'
"use strict";
function ke(){let t=process.platform;if(t!==`darwin`&&t!==`win32`)return{status:`unsupported`,reason:`Cowork is not currently supported on ${a.it()}`,unsupportedCode:`unsupported_platform`};return{status:`supported`}}
const gate=ke();
function checkOrigin(n){if(!$m(n))throw Error(`Incoming "choose" call on interface "LocalExecConsent" from '${n.senderFrame?.url}' did not pass origin validation`)}
function hostPlat(e){if(process.platform===`linux`)return e===`arm64`?`linux-arm64`:`linux-x64`;throw Error(`Unsupported platform: ${process.platform}-${e}`)}
function extInstall(){if(process.platform!==`darwin`)return{status:E.i.Error,error:`Unsupported platform: ${process.platform}. Only macOS is supported.`};return{status:0}}
const winOpts={minWidth:600,titleBarStyle:`hidden`,titleBarOverlay:!1,trafficLightPosition:Xe.o,show:t,webPreferences:{}};
const aboutOpts={titleBarStyle:`hiddenInset`,autoHideMenuBar:!0,skipTaskbar:!0};
function guard(){return Zq.protocol===`file:`&&r.default.app.isPackaged===!0}
function buildArgs(){Xp.push(`--effort`,this.options.effort)}
function handoff(){mB.app.invalidateCurrentActivity();mB.app.setUserActivity(qq,{})}
function wrapSpawn(t){return process.platform!==`darwin`?t:{cmd:rpt(),args:[t.cmd,...t.args]}}
const res=T.app.isPackaged?process.resourcesPath:someFallback;
function c(e,t){let n=i.app.isPackaged?r.default.join(process.resourcesPath,`app.asar`):i.app.getAppPath();return r.default.join(n,`.vite`)}
function v(){return o.default.join(process.resourcesPath,`app.asar`,`.vite`,`build`,`shell-path-worker`,`shellPathWorker.js`)}
EOF
}

# ---------------------------------------------------------------------------
section "1. Static analysis"
# ---------------------------------------------------------------------------
if python3 -c "import ast; ast.parse(open('$REPO_ROOT/enable-cowork.py').read())" 2>/dev/null; then
  pass "enable-cowork.py parses"; else fail "enable-cowork.py parses"; fi
for s in launch.sh install.sh; do
  if bash -n "$REPO_ROOT/$s" 2>/dev/null; then pass "$s syntax"; else fail "$s syntax"; fi
done

# ---------------------------------------------------------------------------
section "2. enable-cowork.py on a chunk with rotated identifiers"
# ---------------------------------------------------------------------------
CHUNK="$TMP/index.chunk-V9ybBkRT.js"
write_patch_fixture "$CHUNK"
assert_parses "$CHUNK" "fixture chunk parses before patching"
python3 "$REPO_ROOT/enable-cowork.py" "$CHUNK" >/dev/null 2>&1
assert_grep  "$CHUNK" 'cowork-patched'                 "platform-gate marker present"
assert_grep  "$CHUNK" 'cowork-ipc-patched'             "IPC marker present"
assert_grep  "$CHUNK" 'cowork-platform-return-patched' "return-gate marker present"
assert_grep  "$CHUNK" 'function qZ9\(\)\{return\{status:"supported"\}\}' "platform gate returns supported"
# IPC guard: validator $m and sender arg n both preserved, file:// exempted
assert_grep  "$CHUNK" 'if\(!\$m\(n\)&&!\(n\.senderFrame&&n\.senderFrame\.url&&n\.senderFrame\.url\.startsWith\("file://"\)\)\)' \
             "IPC guard exempts file:// (rotated validator \$m + arg n)"
assert_grep  "$CHUNK" 'return"darwin-x64"'             "getHostPlatform throw -> darwin-x64"
refute_grep  "$CHUNK" 'error:`Unsupported platform'    "return-style platform gate neutralized"
assert_parses "$CHUNK" "chunk parses after enable-cowork.py"

# Exit-code contract that install.sh apply_patches relies on to log success
# accurately: a file with the gate (or already patched) exits 0; a shim with no
# gate exits non-zero. apply_patches only reports success if >=1 target exits 0.
if python3 "$REPO_ROOT/enable-cowork.py" "$CHUNK" >/dev/null 2>&1; then
  pass "re-running on an already-patched gate file exits 0 (idempotent)"
else
  fail "re-running on an already-patched gate file should exit 0"
fi
SHIM="$TMP/shim_index.js"
printf '"use strict";\nrequire("./index.chunk-V9ybBkRT.js");\n' > "$SHIM"
if python3 "$REPO_ROOT/enable-cowork.py" "$SHIM" >/dev/null 2>&1; then
  fail "shim with no platform gate should exit non-zero"
else
  pass "shim with no platform gate exits non-zero (apply_patches won't false-succeed)"
fi

# ---------------------------------------------------------------------------
section "3. build-dir chunk discovery (install.sh / launch.sh)"
# ---------------------------------------------------------------------------
mkdir -p "$TMP/build"
printf '"use strict";\nrequire("./index.chunk-V9ybBkRT.js");\n' > "$TMP/build/index.js"
: > "$TMP/build/index.chunk-V9ybBkRT.js"
# Named by the shim -> must be found.
found="$(discover_chunks "$TMP/build")"
[[ "$found" == *"index.chunk-V9ybBkRT.js"* ]] && pass "split-entry: shim-named chunk discovered" \
  || fail "split-entry: shim-named chunk discovered (got: '$found')"
# The index2 series carries the platform gate on 1.26832.0.
: > "$TMP/build/index2.chunk-CQIegP9t.js"
found="$(discover_chunks "$TMP/build")"
[[ "$found" == *"index2.chunk-CQIegP9t.js"* ]] && pass "index2 series discovered (gate lives here on 1.26832.0)" \
  || fail "index2 series discovered (got: '$found')"
# Required transitively by another chunk, never named by the shim: this is the
# case that made the --effort patch silently no-op before the glob switch.
: > "$TMP/build/index2.chunk-Cqfh0Vpp.js"
found="$(discover_chunks "$TMP/build")"
[[ "$found" == *"index2.chunk-Cqfh0Vpp.js"* ]] && pass "transitively-required chunk discovered (not named by shim)" \
  || fail "transitively-required chunk discovered (got: '$found')"
# Non-chunk files in the same dir must not be picked up.
: > "$TMP/build/mainWindow.js"
[[ "$(discover_chunks "$TMP/build")" != *"mainWindow.js"* ]] && pass "non-chunk files ignored" \
  || fail "non-chunk files ignored"
# Single-entry build (no chunks) -> discovery finds nothing (clean no-op)
mkdir -p "$TMP/build_single"
printf '"use strict";var x=1;\n' > "$TMP/build_single/index.js"
[[ -z "$(discover_chunks "$TMP/build_single")" ]] && pass "single-entry: no chunk discovered (backward compatible)" \
  || fail "single-entry: no chunk discovered"

# ---------------------------------------------------------------------------
section "4. launch.sh patch_index seds on a chunk with rotated identifiers"
# ---------------------------------------------------------------------------
# Extract the real patch_index() helper + every patch_index invocation verbatim
# from launch.sh so this test tracks the shipped code, not a copy.
BLOCK="$TMP/patch_block.sh"
awk '/^patch_index\(\) \{/{f=1} f{print} /Only repack if stub/{exit}' "$REPO_ROOT/launch.sh" \
  | sed '/# Only repack if stub/d' > "$BLOCK"
NCALLS="$(grep -c '^patch_index ' "$BLOCK" || true)"
if [[ "${NCALLS:-0}" -lt 1 ]]; then
  fail "extracted patch_index block from launch.sh (found $NCALLS calls)"
else
  pass "extracted patch_index block from launch.sh ($NCALLS calls)"
  LCHUNK="$TMP/launch_chunk.js"
  write_patch_fixture "$LCHUNK"
  ( INDEX_TARGETS=("$LCHUNK"); source "$BLOCK" ) >/dev/null 2>&1
  refute_grep "$LCHUNK" 'titleBarStyle:"hidden"'                     "main-window titlebar removed"
  refute_grep "$LCHUNK" 'titleBarStyle:"hiddenInset"'                "about-window titlebar removed"
  assert_grep "$LCHUNK" 'return Zq\.protocol==="file:"\}'            "origin isPackaged requirement dropped for file://"
  assert_grep "$LCHUNK" 'this\.options\.effort==="xhigh"\?"max"'     "--effort xhigh -> max"
  assert_grep "$LCHUNK" '\(mB\.app\.invalidateCurrentActivity\|\|function\(\)\{\}\)\(\)' "Handoff invalidateCurrentActivity no-op fallback"
  assert_grep "$LCHUNK" '\(mB\.app\.setUserActivity\|\|function\(\)\{\}\)\)\(qq,'          "Handoff setUserActivity no-op fallback"
  refute_grep "$LCHUNK" 'kk\.app\.isPackaged\?process\.resourcesPath:' "resourcesPath fallback forced"
  assert_grep "$LCHUNK" 'kk\.app\.isPackaged\?jn\.join\(kk\.app\.getAppPath\(\),"mcp-runtime"' "MCP node-host uses getAppPath()"
  # The disclaimer wrap site must survive patching untouched. Neutralising it to
  # the asar's non-darwin (identity) branch is a tempting simplification -- it
  # removes the wrap/unwrap round-trip -- but that wrap is the only chokepoint
  # where our spawn interception sees the bundle's spawn decisions, and the
  # unwrap substitutes our resolved Claude binary for whatever path the asar
  # chose. Patching it away regresses #132, silently and only at session spawn.
  assert_grep "$LCHUNK" 'function wrapSpawn\(t\)\{return process\.platform!=="darwin"\?t:\{cmd:rpt\(\)' \
              "disclaimer wrap site left intact (removing it would regress #132)"
  assert_parses "$LCHUNK" "chunk parses after launch.sh patches"
fi

# ---------------------------------------------------------------------------
section "5. PKGBUILD build() patches reach the chunk (AUR path, issue #156)"
# ---------------------------------------------------------------------------
# The AUR PKGBUILD applies the same class of patches as launch.sh, but in its
# own build() function. It regressed once (issue #156): it patched index.js
# only and hardcoded minified identifiers, silently disabling Cowork on
# split-entry builds. Extract its patch_index() helper + invocations verbatim
# and exercise them on a chunk with rotated identifiers so the drift can't recur.
PKGBLOCK="$TMP/pkg_patch_block.sh"
awk '/^    patch_index\(\) \{/{inf=1} inf{print} inf&&/^    \}/{inf=0}' "$REPO_ROOT/PKGBUILD" > "$PKGBLOCK"
grep -A2 '^    patch_index "' "$REPO_ROOT/PKGBUILD" | grep -v '^--$' >> "$PKGBLOCK"
PKCALLS="$(grep -c '^    patch_index ' "$PKGBLOCK" || true)"
if [[ "${PKCALLS:-0}" -lt 1 ]]; then
  fail "extracted patch_index block from PKGBUILD (found $PKCALLS calls)"
else
  pass "extracted patch_index block from PKGBUILD ($PKCALLS calls)"
  PKCHUNK="$TMP/pkg_chunk.js"
  write_patch_fixture "$PKCHUNK"
  ( _index_targets=("$PKCHUNK"); source "$PKGBLOCK" ) >/dev/null 2>&1
  refute_grep "$PKCHUNK" 'titleBarStyle:"hidden"'          "PKGBUILD: main-window titlebar removed (chunk)"
  refute_grep "$PKCHUNK" 'titleBarStyle:"hiddenInset"'     "PKGBUILD: about-window titlebar removed (chunk)"
  assert_grep "$PKCHUNK" 'return Zq\.protocol==="file:"\}' "PKGBUILD: origin isPackaged dropped for file:// (chunk)"
  assert_grep "$PKCHUNK" 'function wrapSpawn\(t\)\{return process\.platform!=="darwin"\?t:\{cmd:rpt\(\)' \
              "PKGBUILD: disclaimer wrap site left intact (chunk)"
  assert_parses "$PKCHUNK" "PKGBUILD: chunk parses after patch_index seds"
fi
# Source-level guards: the recipe must discover chunks and run enable-cowork.py
# across every discovered target, never regress to the index.js-only invocation.
# Either mechanism counts: following the shim's require()s (the historical
# approach) or globbing the build dir for index*.chunk-*.js (which also reaches
# chunks required transitively rather than by the shim directly).
if grep -qF 'chunk-[A-Za-z0-9_-]+' "$REPO_ROOT/PKGBUILD" \
   || grep -qF "name 'index*.chunk-*.js'" "$REPO_ROOT/PKGBUILD"; then
  pass "PKGBUILD: discovers index*.chunk-*.js chunks"
else
  fail "PKGBUILD: chunk discovery missing"
fi
if grep -q 'enable-cowork.py" "$_t"' "$REPO_ROOT/PKGBUILD"; then
  pass "PKGBUILD: runs enable-cowork.py across every discovered target"
else
  fail "PKGBUILD: enable-cowork.py not run per-target (regressed to index.js only?)"
fi

# ---------------------------------------------------------------------------
section "6. backtick-literal bundle (asar 1.26832.0 shapes, issue #166)"
# ---------------------------------------------------------------------------
# Everything above uses a double-quoted fixture. 1.26832.0 emits backtick
# template literals instead, which made every pattern miss and every patch
# no-op silently. Re-run both toolchains against a fixture in those shapes so
# a future re-narrowing of ["`] back to " fails here instead of shipping.
BTCHUNK="$TMP/backtick_chunk.js"
write_patch_fixture_backtick "$BTCHUNK"

# enable-cowork.py: the platform gate must be found despite `let` + backticks.
if python3 "$REPO_ROOT/enable-cowork.py" "$BTCHUNK" >/dev/null 2>&1; then
  pass "backtick: enable-cowork.py finds the platform gate (exit 0)"
else
  fail "backtick: enable-cowork.py finds the platform gate (exit 0)"
fi
assert_grep "$BTCHUNK" 'function ke\(\)\{return\{status:"supported"\}\}' "backtick: gate returns supported"
# Bare `throw Error(` — the old pattern required `new`.
refute_grep "$BTCHUNK" 'throw Error\(`Unsupported platform'          "backtick: getHostPlatform throw rewritten"
assert_grep "$BTCHUNK" 'did not pass origin validation'              "backtick: IPC guard site still present"
assert_grep "$BTCHUNK" 'startsWith\("file://"\)'                    "backtick: IPC origin guard exempts file://"
refute_grep "$BTCHUNK" 'error:`Unsupported platform'                 "backtick: return-style platform gate neutralized"
assert_parses "$BTCHUNK" "backtick: chunk parses after enable-cowork.py"

# The fixture above is found via the exact `ke()` entry in KNOWN_PATTERNS, so it
# does NOT exercise PLATFORM_GATE_RE. Minified names rotate every build, so the
# regex fallback is what actually carries the next one — give it a gate name
# that is in no known-pattern list, still backtick/`let` shaped.
BTGATE="$TMP/backtick_unknown_gate.js"
cat > "$BTGATE" <<'EOF'
"use strict";
function zQ7x(){let q=process.platform;if(q!==`darwin`&&q!==`win32`)return{status:`unsupported`,reason:`nope`};return{status:`supported`}}
EOF
if python3 "$REPO_ROOT/enable-cowork.py" "$BTGATE" >/dev/null 2>&1; then
  pass "backtick: regex fallback finds an unknown-named gate"
else
  fail "backtick: regex fallback finds an unknown-named gate"
fi
assert_grep "$BTGATE" 'function zQ7x\(\)\{return\{status:"supported"\}\}' "backtick: unknown-named gate rewritten"
assert_parses "$BTGATE" "backtick: unknown-named gate parses after patching"

# launch.sh patch_index passes against the same shapes.
if [[ -f "$BLOCK" ]]; then
  BTL="$TMP/backtick_launch.js"
  write_patch_fixture_backtick "$BTL"
  ( INDEX_TARGETS=("$BTL"); source "$BLOCK" ) >/dev/null 2>&1
  refute_grep "$BTL" 'titleBarStyle:`hidden`'          "backtick: main-window titlebar removed (!1 / dotted value)"
  refute_grep "$BTL" 'titleBarStyle:`hiddenInset`'     "backtick: about-window titlebar removed"
  assert_grep "$BTL" 'return Zq\.protocol==="file:"\}' "backtick: origin isPackaged dropped (r.default arg)"
  assert_grep "$BTL" 'this\.options\.effort==="xhigh"\?"max"' "backtick: --effort xhigh -> max"
  refute_grep "$BTL" 'T\.app\.isPackaged?process\.resourcesPath:'    "backtick: resourcesPath fallback forced"
  assert_grep "$BTL" 'i\.app\.isPackaged\?r\.default\.join\(i\.app\.getAppPath\(\)' "backtick: guarded MCP join uses getAppPath()"
  # Unguarded join (@shawnyeager, #167): no isPackaged, so the guarded pass
  # can't reach it and shellPathWorker.js resolves through the overridden
  # resourcesPath. The catch-all pass must run after the guarded one.
  refute_grep "$BTL" 'process\.resourcesPath,`app\.asar`' "backtick: unguarded shellPathWorker join rewritten"
  assert_grep "$BTL" 'shell-path-worker'                  "backtick: shellPathWorker site still resolves a path"
  assert_grep "$BTL" 'function wrapSpawn\(t\)\{return process\.platform!==`darwin`\?t:\{cmd:rpt\(\)' \
              "backtick: disclaimer wrap site left intact (#132)"
  assert_parses "$BTL" "backtick: chunk parses after launch.sh patches"
fi

# ---------------------------------------------------------------------------
echo -e "\n${BOLD}Summary:${NC} ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC}"
[[ "$FAIL" -eq 0 ]]
