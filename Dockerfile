# OTD Palace: the built React front end served by the Flask app under waitress.
#
# Two stages. The first builds the front end with the exact Node packages of frontend/package-lock.json; the
# second is a slim Python image holding only what runs: advisor/ (with the demo fixture, advisor/fixtures/),
# server.py, the built front end and the runtime requirements (pinned, with hashes, from uv.lock).
#
# Versions: Node 26.4.0 is the version the front end is built and tested with (vite needs 20.19 or 22.12 and
# later, the test tools 22.22, 24.15 or 26); Python 3.13.12 is the interpreter of the uv environment the tests run
# in (pyproject.toml asks >= 3.12). Change them together with the local toolchain.

# ---- Stage 1: the front end ---------------------------------------------------------------------------------
FROM node:26.4.0-slim AS frontend

WORKDIR /build/frontend
# The lock file alone decides what gets installed. No package needs an install script on Linux (the only one
# that has one, fsevents, is macOS-only), so none runs.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY frontend/ ./
# vite.config.ts builds into ../advisor/static, that is /build/advisor/static.
RUN npm run build

# ---- Stage 2: the server ------------------------------------------------------------------------------------
FROM python:3.13.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PORT=8080

# The server runs as this unprivileged user. It owns /app/data and nothing else: the code stays root-owned
# and read-only to it.
RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid app --home-dir /app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app

# Every package and its hash come from requirements.txt (exported from uv.lock). All are wheels but http-ece, pure Python, which pip builds from its source archive.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt

COPY server.py ./
# The demo fixture comes with the package (advisor/fixtures/), outside the data directory a volume would hide.
COPY advisor/ ./advisor/
COPY --from=frontend /build/advisor/static/ ./advisor/static/

RUN python -m compileall -q advisor server.py \
 && mkdir -p /app/data \
 && chown app:app /app/data

# The start script. The data directory is ADVISOR_DATA_DIR (data/ by default, taken from /app when relative),
# where the server keeps the click counts, the push subscriptions and the photo cache. It refuses one that is /app
# itself, the root or any directory above /app, since it is about to hand that directory to the app user (server.py
# refuses the same). A mounted volume can arrive owned by root: started as root, the script gives the data
# directory to the app user and drops root before the server starts. Started as the app
# user (the default here), it only checks that the server can write there.
RUN printf '%s\n' \
      '#!/bin/sh' \
      '# Starts OTD Palace. Written by the Dockerfile.' \
      'set -eu' \
      'data="${ADVISOR_DATA_DIR:-data}"' \
      'case "$data" in /*) ;; *) data="/app/$data" ;; esac' \
      'data="$(python -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$data")"' \
      'case "/app/" in "$data"/*) bad=1 ;; *) bad=0 ;; esac' \
      'if [ "$data" = "/" ] || [ "$bad" = "1" ]; then' \
      '  echo "start: ADVISOR_DATA_DIR must be a directory of its own, not $data, which holds /app" >&2' \
      '  exit 1' \
      'fi' \
      'if [ "$(id -u)" = "0" ]; then' \
      '  mkdir -p "$data/photos"' \
      '  chown -R app:app "$data"' \
      '  exec python -c "import os, pwd, sys; u = pwd.getpwnam(\"app\"); os.setgroups([]); os.setgid(u.pw_gid); os.setuid(u.pw_uid); os.environ[\"HOME\"] = u.pw_dir; os.execv(sys.executable, [sys.executable, \"/app/server.py\"])"' \
      'fi' \
      'mkdir -p "$data" 2>/dev/null || true' \
      'if [ ! -w "$data" ]; then' \
      '  echo "start: $data is not writable by uid $(id -u); mount it writable or start as root" >&2' \
      '  exit 1' \
      'fi' \
      'exec python /app/server.py' \
    > /usr/local/bin/palace-start \
 && chmod 0755 /usr/local/bin/palace-start

USER app

# server.py listens on 0.0.0.0:$PORT. A platform can inject PORT; 8080 is the image's default.
EXPOSE 8080

# Healthy when /healthz answers and says the data is fresh (ok: true). A platform can probe /healthz too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import json, os, sys, urllib.request; r = urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8080') + '/healthz', timeout=4); sys.exit(0 if json.load(r).get('ok') else 1)"]

ENTRYPOINT ["/usr/local/bin/palace-start"]
