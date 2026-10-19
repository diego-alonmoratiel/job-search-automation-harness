#!/usr/bin/env bash
# install.sh - deploy the job-search harness on the Raspberry Pi.
#
# Run this from the harness directory on the Pi:
#   cd ~/job-harness && ./install.sh
#
# It assumes opencode + bun are installed, the ai-job-search repo is already
# present at AIJOB_DIR, and opencode credentials are in
# ~/.local/share/opencode/auth.json (copy them from the dev machine once).
set -euo pipefail

HARNESS_DIR="${HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
AIJOB_DIR="${AIJOB_DIR:-$HOME/ai-job-search}"
PY="${PY:-python3}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$AIJOB_DIR" ] || die "ai-job-search repo not found at $AIJOB_DIR (set AIJOB_DIR=...)"
command -v "$PY" >/dev/null || die "python3 not found"
command -v opencode >/dev/null || [ -x "$HOME/.opencode/bin/opencode" ] || die "opencode not found"
command -v bun >/dev/null || [ -x "$HOME/.bun/bin/bun" ] || die "bun not found"

say "harness dir: $HARNESS_DIR"
say "ai-job-search: $AIJOB_DIR"

mkdir -p "$HARNESS_DIR/state"
chmod +x "$HARNESS_DIR/bin/"* 2>/dev/null || true

# 1. env file
if [ ! -f "$HARNESS_DIR/config/harness.env" ]; then
  cp "$HARNESS_DIR/config/harness.env.example" "$HARNESS_DIR/config/harness.env"
  chmod 600 "$HARNESS_DIR/config/harness.env"
  say "created config/harness.env from example - FILL IN the Telegram token and owner id"
fi

# 2. opencode credentials
AUTH="$HOME/.local/share/opencode/auth.json"
if [ ! -s "$AUTH" ]; then
  say "WARNING: $AUTH is missing or empty. Copy your opencode credentials before the first run:"
  say "  scp <dev>:\$HOME/.local/share/opencode/auth.json ~/.local/share/opencode/auth.json"
fi

# 3. patch the repo's opencode.json with the harness overrides (deep merge)
say "patching $AIJOB_DIR/opencode.json"
"$PY" - "$AIJOB_DIR/opencode.json" "$HARNESS_DIR/config/opencode.overrides.json" <<'PYEOF'
import json, sys
target, overlay = sys.argv[1], sys.argv[2]

def deep_merge(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            deep_merge(a[k], v)
        else:
            a[k] = v
    return a

with open(target, encoding="utf-8") as fh:
    base = json.load(fh)
with open(overlay, encoding="utf-8") as fh:
    over = json.load(fh)
deep_merge(base, over)
with open(target, "w", encoding="utf-8") as fh:
    json.dump(base, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print("opencode.json patched")
PYEOF

# 4. install opencode agent files into the repo
say "installing opencode agents"
mkdir -p "$AIJOB_DIR/.opencode/agent" "$AIJOB_DIR/.opencode/command"
cp "$HARNESS_DIR/agents/harness.md" "$AIJOB_DIR/.opencode/agent/harness.md"
cp "$HARNESS_DIR/agents/general-purpose.md" "$AIJOB_DIR/.opencode/agent/general-purpose.md"
cp "$HARNESS_DIR/agents/chat.md" "$AIJOB_DIR/.opencode/command/chat.md"
cp "$HARNESS_DIR/agents/score.md" "$AIJOB_DIR/.opencode/command/score.md"

# 5. systemd user units
say "installing systemd user units"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cp "$HARNESS_DIR/systemd/"*.service "$HARNESS_DIR/systemd/"*.timer "$UNIT_DIR/"
sudo loginctl enable-linger "$USER" || true
systemctl --user daemon-reload
systemctl --user enable --now job-xvfb.service job-tg.service job-daily.timer job-fscheck.timer

say "done. status:"
systemctl --user --no-pager --no-legend status job-tg.service 2>/dev/null | head -3 || true
systemctl --user --no-pager list-timers 'job-*' || true
say "edit $HARNESS_DIR/config/harness.env, then: systemctl --user restart job-tg.service"
