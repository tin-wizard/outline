#!/bin/sh
# Roll the Hetzner production deployment back to a specific published image tag.
#
# Watchtower auto-deploys whatever `latest` points to in GHCR on every push to
# main (see docker-compose.hetzner.yml). If a bad deploy goes out, this is the
# one-command way back: it re-pins OUTLINE_TAG in .env to a known-good commit
# sha, pulls that exact image, restarts only the outline container, and waits
# for it to report healthy before handing control back.
#
# Run this ON THE HETZNER HOST, from /root/outline (where docker-compose.hetzner.yml
# and .env live):
#
#   ./deploy/scripts/rollback.sh <commit-sha>
#
# <commit-sha> is the short (7-char) sha that build-image.yml tagged the image
# with, e.g. from `git log --oneline` in this repo, or from the "Build and
# publish image" workflow run summary for the last known-good commit.
#
# To go back to auto-deploy afterward, either:
#   - fix forward: push a new commit, Watchtower picks up the new `latest`, or
#   - explicitly re-arm: set OUTLINE_TAG=latest in .env and re-run this script
#     with "latest" as the argument.
set -eu

COMPOSE_FILE="docker-compose.hetzner.yml"
ENV_FILE=".env"

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <commit-sha-or-tag>" >&2
  echo "  e.g. $0 1e238af" >&2
  echo "  e.g. $0 latest    (re-arm auto-deploy)" >&2
  exit 1
fi

TARGET_TAG="$1"
IMAGE="ghcr.io/tin-wizard/outline:${TARGET_TAG}"

if [ ! -f "$COMPOSE_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "error: run this from the directory containing $COMPOSE_FILE and $ENV_FILE (normally /root/outline)" >&2
  exit 1
fi

echo "==> Verifying ${IMAGE} actually exists before touching anything..."
if ! docker manifest inspect "$IMAGE" >/dev/null 2>&1; then
  echo "error: ${IMAGE} was not found on GHCR (typo in the tag, or it was never published for that commit)." >&2
  exit 1
fi

PREVIOUS_TAG=$(grep -E '^OUTLINE_TAG=' "$ENV_FILE" | cut -d= -f2- || true)
echo "==> Current OUTLINE_TAG: ${PREVIOUS_TAG:-<unset, defaults to latest>}"
echo "==> Rolling to:          ${TARGET_TAG}"

# Keep a one-line breadcrumb of the last few switches so a rollback of a
# rollback doesn't rely on anyone's memory either.
{
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${PREVIOUS_TAG:-latest} -> ${TARGET_TAG}"
} >> rollback.log

if grep -qE '^OUTLINE_TAG=' "$ENV_FILE"; then
  sed -i.bak "s/^OUTLINE_TAG=.*/OUTLINE_TAG=${TARGET_TAG}/" "$ENV_FILE"
else
  echo "OUTLINE_TAG=${TARGET_TAG}" >> "$ENV_FILE"
fi
rm -f "${ENV_FILE}.bak"

echo "==> Pulling ${IMAGE}..."
docker compose -f "$COMPOSE_FILE" pull outline

echo "==> Recreating the outline container on the new image..."
docker compose -f "$COMPOSE_FILE" up -d outline

echo "==> Waiting for it to report healthy (up to 2 minutes)..."
i=0
while [ "$i" -lt 24 ]; do
  status=$(docker inspect --format='{{.State.Health.Status}}' outline-outline-1 2>/dev/null || echo "unknown")
  if [ "$status" = "healthy" ]; then
    echo "==> Healthy. Now running ${IMAGE}."
    exit 0
  fi
  if [ "$status" = "unhealthy" ]; then
    echo "error: container reports unhealthy on ${IMAGE}. Check: docker logs outline-outline-1" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 5
done

echo "warning: did not reach healthy within 2 minutes. Check: docker logs outline-outline-1" >&2
exit 1
