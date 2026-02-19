#!/usr/bin/env bash
set -euo pipefail

################################################################################
# Example deploy.sh — reference implementation
#
# This script is run by the Deploy Receiver service after a successful image push.
#
# It demonstrates how to:
#   1) Use env vars passed by the receiver
#   2) Pull the new Docker image from GHCR
#   3) Fetch secrets from Vaultwarden via Bitwarden CLI (bw) non-interactively
#   4) Restart the container with the new image
#
# Place a customized version of this script in:
#   /home/debian/apps/<your-repo>/deploy.sh
#
# Make it executable:
#   chmod +x /home/debian/apps/<your-repo>/deploy.sh
################################################################################

################################################################################
# Environment variables provided by Deploy Receiver:
#
# DEPLOY_REPO                 - Repo slug (e.g., "blitzed")
# DEPLOY_IMAGE                - Full image reference (e.g., "ghcr.io/tihlde/blitzed")
# DEPLOY_TAG                  - Image tag that was just pushed (e.g., "latest", "dev")
# DEPLOY_ENV                  - Environment: "prod", "dev", or ""
# VAULTWARDEN_MASTER_PASSWORD - Master password for unlocking Vaultwarden via bw
# GHCR_PAT                    - GitHub Container Registry PAT (read:packages)
################################################################################

### PROJECT-SPECIFIC CONFIG (customize for your repo) ###
APP_NAME="${DEPLOY_REPO}.tihlde.org"   # Container name
CONTAINER_PORT=3000                   # Port your app listens on inside the container
HOST_PORT=4000                        # Port exposed on the host

# Vaultwarden secret item ID (get this from `bw list items`)
# This item's "Notes" field should contain KEY=VALUE env vars for your app
VAULTWARDEN_ITEM_ID="your-item-uuid-here"

# GHCR username (usually the org or user that owns the image)
# Note: Username can be mixed-case; the PAT decides access.
GHCR_USER="tihlde"
### /CONFIG ###

################################################################################
# Validation / Info
################################################################################

: "${DEPLOY_REPO:?Missing DEPLOY_REPO}"
: "${DEPLOY_IMAGE:?Missing DEPLOY_IMAGE}"
: "${DEPLOY_TAG:?Missing DEPLOY_TAG}"
: "${VAULTWARDEN_MASTER_PASSWORD:?Missing VAULTWARDEN_MASTER_PASSWORD}"
: "${GHCR_PAT:?Missing GHCR_PAT}"

echo "[deploy.sh] Starting deployment"
echo "[deploy.sh] Repo: ${DEPLOY_REPO}"
echo "[deploy.sh] Image: ${DEPLOY_IMAGE}:${DEPLOY_TAG}"
echo "[deploy.sh] Environment: ${DEPLOY_ENV:-<empty>}"

# Dependencies
for cmd in docker bw jq; do
  command -v "$cmd" >/dev/null || { echo "ERROR: $cmd not found"; exit 1; }
done

################################################################################
# Cleanup on exit
################################################################################

ENV_TMP=""
cleanup() {
  [[ -n "$ENV_TMP" ]] && rm -f "$ENV_TMP"
  docker logout ghcr.io >/dev/null 2>&1 || true
}
trap cleanup EXIT

################################################################################
# 1) Login + pull image
################################################################################

echo "▸ Logging in to GHCR…"
printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null

echo "▸ Pulling ${DEPLOY_IMAGE}:${DEPLOY_TAG}…"
docker pull "${DEPLOY_IMAGE}:${DEPLOY_TAG}" >/dev/null

################################################################################
# 2) Vaultwarden: unlock non-interactively + fetch env from item notes
################################################################################

echo "▸ Unlocking Vaultwarden…"

# Fail fast if bw has never been logged in for this HOME.
# (Deploy Receiver often sets HOME to the repo directory.)
STATUS="$(bw status | jq -r .status 2>/dev/null || echo unauthenticated)"
if [[ "$STATUS" == "unauthenticated" ]]; then
  echo "ERROR: Bitwarden CLI (bw) is not logged in for HOME=$HOME."
  echo "       Run 'bw login' once in this environment, then re-run deploy."
  exit 1
fi

export BW_SESSION="$(bw unlock --passwordenv VAULTWARDEN_MASTER_PASSWORD --raw)"
bw sync --session "$BW_SESSION" >/dev/null

umask 077
ENV_TMP="$(mktemp "/tmp/${APP_NAME}.env.XXXXXX")"

# Fetch env content from Notes. Strip Windows CRLF if present.
bw get item "$VAULTWARDEN_ITEM_ID" --session "$BW_SESSION" \
  | jq -r '.notes // empty' \
  | sed 's/\r$//' > "$ENV_TMP"

if [[ ! -s "$ENV_TMP" ]]; then
  echo "ERROR: Env content is empty. Ensure the item Notes contains KEY=VALUE lines."
  exit 1
fi

chmod 0600 "$ENV_TMP"

################################################################################
# 3) Restart container
################################################################################

echo "▸ Restarting container…"
docker rm -f "$APP_NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$APP_NAME" \
  --restart unless-stopped \
  --env-file "$ENV_TMP" \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  "${DEPLOY_IMAGE}:${DEPLOY_TAG}" >/dev/null

echo "✔ Deployed successfully:"
docker ps --filter "name=^/${APP_NAME}$"
