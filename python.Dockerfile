# ─── specialized Python Worker Image ──────────────────────────────────────────
FROM python:3.12-slim

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install common Python libraries for AI/Web projects
RUN pip install --no-cache-dir \
    fastapi \
    uvicorn \
    requests \
    numpy \
    pandas \
    jinja2

WORKDIR /app
EXPOSE 8000 8080
CMD ["tail", "-f", "/dev/null"]
