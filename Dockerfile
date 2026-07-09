# gkall.online — portfolio-mode container
# Runs the Python stdlib server behind a reverse proxy (nginx / Caddy / etc.)
# on the recon.hagai.online droplet. SQLite DB lives on a persistent volume.

FROM python:3.12-slim

# System deps — nothing beyond what stdlib gives us
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# App code
COPY server/       /app/server/
COPY public/       /app/public/

# Data volume — SQLite DB + logs land here so container upgrades don't wipe state
RUN mkdir -p /data
VOLUME ["/data"]

# Portfolio-mode defaults
ENV PORTFOLIO_MODE=1 \
    PRIZE_USDT=0 \
    MONTHLY_PRIZES=0,0,0 \
    DB_PATH=/data/quizdb.sqlite \
    STATIC_DIR=/app/public \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:8080/api/health >/dev/null || exit 1

CMD ["python", "-u", "/app/server/server.py"]
