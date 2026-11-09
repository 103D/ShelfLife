#!/usr/bin/env bash
# Runs a Cloudflare quick tunnel (https://<random>.trycloudflare.com) and keeps
# the app in sync when the URL changes (quick tunnels get a new URL on restart).
#
# On a new URL it:
#   1. writes WEBAPP_URL into the systemd EnvironmentFile
#   2. restarts the shelflife service (so the bot serves the right link)
#   3. re-binds the Telegram Menu Button via setChatMenuButton
#
# Needs passwordless sudo for `opc` (default on Oracle Cloud images).
#
# This is the no-domain, no-account fallback for permanent HTTPS. For a truly
# immutable URL, use a Cloudflare Named Tunnel with your own domain.
set -u

ENV_FILE="${ENV_FILE:-/etc/shelflife/env}"
CLOUDFLARED="${CLOUDFLARED:-/usr/local/bin/cloudflared}"
APP_URL_LOCAL="${APP_URL_LOCAL:-http://localhost:3000}"

log() { printf '[tunnel] %s\n' "$*"; }

get_env_var() {
  # Value of KEY=... from the EnvironmentFile (sudo: file is root-only).
  sudo grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"\r'
}

apply_url() {
  local url="$1"
  log "New tunnel URL: $url"

  # 1. Persist the URL for the app/bot.
  if ! sudo sed -i "s|^WEBAPP_URL=.*|WEBAPP_URL=${url}|" "$ENV_FILE"; then
    log "ERROR: failed to update WEBAPP_URL in $ENV_FILE"
    return 1
  fi
  log "WEBAPP_URL updated in $ENV_FILE"

  # 2. Restart the app so the bot and Mini App pick up the new URL.
  if sudo systemctl restart shelflife; then
    log "shelflife restarted"
  else
    log "WARN: shelflife restart failed"
  fi

  # 3. Re-bind the Telegram Menu Button to the new URL.
  local token
  token="$(get_env_var BOT_TOKEN)"
  if [ -n "${token:-}" ]; then
    local resp
    resp="$(curl -s --max-time 15 -X POST "https://api.telegram.org/bot${token}/setChatMenuButton" \
      -H 'Content-Type: application/json' \
      -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"📦 ShelfLife\",\"web_app\":{\"url\":\"${url}\"}}}")" || resp=""
    log "setChatMenuButton: ${resp:-<no response>}"
  else
    log "WARN: BOT_TOKEN missing; Menu Button not updated"
  fi
}

current_url="$(get_env_var WEBAPP_URL || true)"
log "Starting quick tunnel -> $APP_URL_LOCAL (current WEBAPP_URL: ${current_url:-<unset>})"

# cloudflared writes the public URL to stderr; merge streams and watch line by line.
# Restart=always on the unit restarts this whole script if cloudflared dies.
# The `while` loop runs in a subshell (right side of a pipe) — `current_url`
# updates persist across loop iterations within that subshell.
"$CLOUDFLARED" tunnel --no-autoupdate --loglevel info --url "$APP_URL_LOCAL" 2>&1 \
  | while IFS= read -r line; do
      printf '%s\n' "$line"
      url="$(printf '%s\n' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"
      if [ -n "${url:-}" ] && [ "$url" != "$current_url" ]; then
        current_url="$url"
        apply_url "$url"
      fi
    done
