# ─── Stage 1: Build TypeScript ───────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─── Stage 2: Production Image ───────────────────────────────────────────────
# We use a full Debian image (not slim) so we can install Docker CLI.
# The Docker daemon itself runs on the HOST (Fly machine in privileged mode).
# This container only needs the Docker CLI + socket to talk to it.
FROM node:20-bookworm AS runner

WORKDIR /app

# ── Install Docker CLI (client only, not the daemon) ──────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# ── Install native Node deps (better-sqlite3 needs build tools) ───────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Worker Dockerfiles needed at runtime for building project images
COPY node.Dockerfile ./node.Dockerfile
COPY python.Dockerfile ./python.Dockerfile

# Create directories for persistent data
RUN mkdir -p /app/projects /app/data /app/logs

EXPOSE 4000

ENV NODE_ENV=production
ENV PORT=4000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
