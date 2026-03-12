#!/usr/bin/env bash
set -euo pipefail

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Coder AI — Deploy Script"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Pre-build worker images (if not already built) ──
echo ""
echo "▶ Building worker images..."

if ! docker image inspect coder-node &>/dev/null; then
  echo "  Building coder-node..."
  docker build -f node.Dockerfile -t coder-node .
else
  echo "  coder-node already exists — skipping"
fi

if ! docker image inspect coder-python &>/dev/null; then
  echo "  Building coder-python..."
  docker build -f python.Dockerfile -t coder-python .
else
  echo "  coder-python already exists — skipping"
fi

# ── 2. Pull/build orchestrator image ──
echo ""
echo "▶ Building orchestrator image..."
docker-compose build --no-cache orchestrator

# ── 3. Start (or restart) via docker-compose ──
echo ""
echo "▶ Starting orchestrator..."
docker-compose up -d --remove-orphans

echo ""
echo "✅ Deployed! Orchestrator running on port ${PORT:-4000}"
echo "   Logs: docker-compose logs -f orchestrator"
