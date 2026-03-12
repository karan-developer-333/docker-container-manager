#!/usr/bin/env bash
# fly-deploy.sh — Full Fly.io deploy + Docker-in-Docker setup
# Run this once for initial deploy, then just `fly deploy` for updates.
set -euo pipefail

APP=${FLY_APP_NAME:-"coderai-orchestrator"}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Coder AI → Fly.io Deploy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Check flyctl is installed ──────────────────────────────────────────────
if ! command -v flyctl &>/dev/null; then
  echo "Installing flyctl..."
  curl -L https://fly.io/install.sh | sh
  export PATH="$HOME/.fly/bin:$PATH"
fi

# ── Create app if it doesn't exist ────────────────────────────────────────
flyctl apps list | grep -q "$APP" || {
  echo "▶ Creating Fly app: $APP"
  flyctl apps create "$APP" --machines
}

# ── Create persistent volume (only first time) ────────────────────────────
flyctl volumes list -a "$APP" | grep -q "coderai_data" || {
  echo "▶ Creating persistent volume (1GB)..."
  flyctl volumes create coderai_data --size 1 --region sin -a "$APP"
}

# ── Set secrets from .env ─────────────────────────────────────────────────
if [ -f .env ]; then
  echo "▶ Setting secrets from .env..."
  # Filter out comments and empty lines, set as Fly secrets
  grep -v '^\s*#' .env | grep -v '^\s*$' | flyctl secrets import -a "$APP"
fi

# ── Deploy ────────────────────────────────────────────────────────────────
echo "▶ Deploying..."
flyctl deploy --remote-only -a "$APP"

# ── Enable Docker-in-Docker (privileged mode) ─────────────────────────────
echo ""
echo "▶ Enabling Docker socket access (privileged machine)..."
MACHINE_ID=$(flyctl machines list -a "$APP" --json | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")

flyctl machines update "$MACHINE_ID" \
  --privileged \
  -a "$APP" \
  --yes

echo ""
echo "✅ Done! App running at: https://${APP}.fly.dev"
echo "   Health: https://${APP}.fly.dev/health"
echo ""
echo "   For updates: flyctl deploy -a $APP"
echo "   For logs:    flyctl logs -a $APP"
