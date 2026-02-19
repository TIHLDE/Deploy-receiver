#!/usr/bin/env bash
set -euo pipefail

################################################################################
# Example deploy.sh — reference implementation
#
# This script is run by the Deploy Receiver service after a successful image push.
# It demonstrates how to:
#   1. Use the environment variables passed by the receiver
#   2. Pull the new Docker image from GHCR
#   3. Fetch secrets from Vaultwarden (or another secret store)
#   4. Restart the container with the new image
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
# DEPLOY_REPO                - Repo slug (e.g., "blitzed")
# DEPLOY_IMAGE               - Full image reference (e.g., "ghcr.io/tihlde/blitzed")
# DEPLOY_TAG                 - Image tag that was just pushed (e.g., "latest", "dev")
# DEPLOY_ENV                 - Environment: "prod", "dev", or ""
# VAULTWARDEN_MASTER_PASSWORD - For unlocking Vaultwarden
# GHCR_PAT                   - GitHub Container Registry personal access token
################################################################################

### PROJECT-SPECIFIC CONFIG (customize for your repo) ###
APP_NAME="${DEPLOY_REPO}.tihlde.org"       # Container name
CONTAINER_PORT=3000                         # Port your app listens on inside the container
HOST_PORT=4000                              # Port exposed on the host

# Vaultwarden secret item ID (get this from `bw list items`)
# This item's "Notes" field should contain KEY=VALUE env vars for your app
VAULTWARDEN_ITEM_ID="your-item-uuid-here"

# GHCR username (usually the org or user that owns the image)
GHCR_USER="tihlde"
### /CONFIG ###

################################################################################
# Validation
################################################################################

echo "[deploy.sh] Starting deployment for ${DEPLOY_REPO}"
echo "[deploy.sh] Image: ${DEPLOY_IMAGE}:${DEPLOY_TAG}"
echo "[deploy.sh] Environment: ${DEPLOY_ENV}"

# Check required env vars from receiver
: "${DEPLOY_REPO:?Missing DEPLOY_REPO}"
: "${DEPLOY_IMAGE:?Missing DEPLOY_IMAGE}"
: "${DEPLOY_TAG:?Missing DEPLOY_TAG}"
: "${VAULTWARDEN_MASTER_PASSWORD:?Missing VAULTWARDEN_MASTER_PASSWORD}"
: "${GHCR_PAT:?Missing GHCR_PAT}"

# Required secrets
: "${VAULTWARDEN_MASTER_PASSWORD:?Missing VAULTWARDEN_MASTER_PASSWORD}"
: "${GHCR_PAT:?Missing GHCR_PAT}"

# Dependencies
command -v docker >/dev/null || { echo "ERROR: docker not found"; exit 1; }
command -v bw >/dev/null || { echo "ERROR: bw (Bitwarden CLI) not found"; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq not found"; exit 1; }

# 1) Login + pull latest image
printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
docker pull "$DEPLOY_IMAGE:$DEPLOY_TAG"

# 2) Unlock Vaultwarden and fetch env (notes -> temp env file)
umask 077
ENV_TMP="$(mktemp /tmp/${APP_NAME}.env.XXXXXX)"
trap 'rm -f "$ENV_TMP"' EXIT

SESSION="$(bw unlock --passwordenv VAULTWARDEN_MASTER_PASSWORD --raw)"
bw sync --session "$SESSION" >/dev/null

bw get item "$VAULTWARDEN_ITEM_ID" --session "$SESSION" \
  | jq -r '.notes // empty' \
  | sed 's/\r$//' > "$ENV_TMP"

if [[ ! -s "$ENV_TMP" ]]; then
  echo "ERROR: Env content is empty. Ensure the item Notes contains KEY=VALUE lines."
  exit 1
fi

chmod 0600 "$ENV_TMP"

# 3) Restart container
docker rm -f "$APP_NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$APP_NAME" \
  --restart unless-stopped \
  --env-file "$ENV_TMP" \
  -p "$HOST_PORT:$CONTAINER_PORT" \
  "$DEPLOY_IMAGE:$DEPLOY_TAG"

docker ps --filter "name=^/${APP_NAME}$"

trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
