# ─── specialized Node.js Worker Image ──────────────────────────────────────────
FROM node:20-slim

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl \
    git \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Bun for speed
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# ─── Pre-cache common packages ────────────────────────────────────────────────
WORKDIR /tmp/precache
RUN echo '{\
  "name":"precache",\
  "version":"1.0.0",\
  "dependencies":{\
    "next":"14.2.0",\
    "react":"^18.3.1",\
    "react-dom":"^18.3.1",\
    "typescript":"^5.5.3",\
    "tailwindcss":"^3.4.1",\
    "postcss":"^8.4.38",\
    "vite":"^5.4.0",\
    "@vitejs/plugin-react":"^4.3.1",\
    "framer-motion":"^11.3.8",\
    "lucide-react":"^0.395.0"\
  }\
}' > package.json
RUN bun install

WORKDIR /app
EXPOSE 3000 5173 8080 4173
CMD ["tail", "-f", "/dev/null"]
