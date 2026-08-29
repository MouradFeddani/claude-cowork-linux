#!/bin/bash
# Deploy local stubs to installed claude-desktop for testing
# Usage: ./test-local.sh [--launch]

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${CLAUDE_INSTALL_DIR:-$HOME/.local/share/claude-desktop}"
EXTRACTED_DIR="$INSTALL_DIR/linux-app-extracted"
LAUNCHER="$HOME/.local/bin/claude-desktop"

if [ ! -d "$INSTALL_DIR" ]; then
    echo "ERROR: install dir not found: $INSTALL_DIR" >&2
    echo "       Run ./install.sh first, or set CLAUDE_INSTALL_DIR." >&2
    exit 1
fi

echo "Deploying local stubs from $REPO_DIR"

# $INSTALL_DIR/stubs is the tree launch.sh re-syncs into the extracted app on
# EVERY start -- swift/native stubs, cowork/*.js, frame-fix/*.js, the plugin
# shim. Writing only into the extracted app (what this script used to do) is
# therefore self-defeating: the next launch copies the installed, unmodified
# stubs straight back over the freshly deployed ones, and you end up testing
# the code you were trying to replace. Nothing at all read the old
# $INSTALL_DIR/frame-fix-wrapper.js destination.
#
# So deploy to $INSTALL_DIR/stubs first -- that is the source of truth -- and
# mirror into the extracted tree afterwards so a direct `electron` run (one
# that bypasses launch.sh) sees the same code.
# Skip when the repo IS the install dir (running from the installed checkout):
# `cp -rf x/stubs x/` is "same file" and aborts under set -e.
if [ "$REPO_DIR" != "$INSTALL_DIR" ]; then
    echo "Syncing stubs/ -> $INSTALL_DIR/stubs/"
    cp -rf "$REPO_DIR/stubs" "$INSTALL_DIR/"
fi

# Mirror into the extracted app. Each destination takes the WHOLE source
# directory, not a hand-listed file: @ant/claude-native/index.js require()s
# ./safe_fs.js at module load, and copying index.js alone (what this script
# used to do) leaves a stub that throws MODULE_NOT_FOUND.
mkdir -p "$EXTRACTED_DIR/node_modules/@ant/claude-swift/js" \
         "$EXTRACTED_DIR/node_modules/@ant/claude-native" \
         "$EXTRACTED_DIR/cowork"

cp -vf "$REPO_DIR"/stubs/@ant/claude-swift/js/*.js \
       "$EXTRACTED_DIR/node_modules/@ant/claude-swift/js/"
cp -vf "$REPO_DIR"/stubs/@ant/claude-native/*.js \
       "$EXTRACTED_DIR/node_modules/@ant/claude-native/"
cp -vf "$REPO_DIR"/stubs/cowork/*.js "$EXTRACTED_DIR/cowork/"

# frame-fix files land at the root of the extracted app, matching
# install_stubs() and launch.sh. protocol-forwarder.js is in the list because
# the generated launcher execs it directly for the claude:// OAuth fast path.
for _ff in frame-fix-entry.js frame-fix-wrapper.js protocol-forwarder.js; do
    [ -f "$REPO_DIR/stubs/frame-fix/$_ff" ] || continue
    cp -vf "$REPO_DIR/stubs/frame-fix/$_ff" "$EXTRACTED_DIR/$_ff"
done

# Clear asar cache to force rebuild
if [ -d "$INSTALL_DIR/.asar-cache" ]; then
    rm -rf "${INSTALL_DIR:?}/.asar-cache"/*
    echo "Cleared .asar-cache"
fi

echo ""
echo "Local stubs deployed. Run claude-desktop to test."

if [ "$1" = "--launch" ]; then
    # The launcher lives in ~/.local/bin, not in the install dir. This used to
    # exec "$INSTALL_DIR/claude-desktop", a path install.sh has never written,
    # so --launch always died with "No such file or directory".
    if [ -x "$LAUNCHER" ]; then
        echo "Launching claude-desktop..."
        exec "$LAUNCHER"
    fi
    echo "Launcher not found at $LAUNCHER; falling back to $INSTALL_DIR/launch.sh"
    exec "$INSTALL_DIR/launch.sh"
fi
