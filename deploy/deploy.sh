#!/usr/bin/env bash

set -euo pipefail

IMAGE_TAG="${1:?An image tag is required}"

if [[ ! "$IMAGE_TAG" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "Image tag must be a Git commit SHA"
  exit 1
fi

cd /opt/shipyard

printf 'SHIPYARD_IMAGE_TAG=%s\n' "$IMAGE_TAG" > .env

GHCR_TOKEN=$(aws ssm get-parameter \
  --region us-east-1 \
  --name "/shipyard/ghcr/token" \
  --with-decryption \
  --query "Parameter.Value" \
  --output text)

DOCKER_CONFIG_DIR=$(mktemp -d)
export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"

cleanup() {
  unset GHCR_TOKEN
  rm -f "$DOCKER_CONFIG_DIR/config.json"
  rmdir "$DOCKER_CONFIG_DIR" 2>/dev/null || true
}

trap cleanup EXIT

printf '%s' "$GHCR_TOKEN" |
  docker login ghcr.io \
    --username "vsonti23" \
    --password-stdin

docker compose pull shipyard

if docker container inspect shipyard >/dev/null 2>&1; then
  COMPOSE_PROJECT=$(docker inspect \
    --format '{{ index .Config.Labels "com.docker.compose.project" }}' \
    shipyard)

  if [[ "$COMPOSE_PROJECT" != "shipyard" ]]; then
    echo "Removing container created by the original docker run deployment"
    docker rm --force shipyard
  fi
fi

docker compose up --detach shipyard

curl \
  --fail \
  --retry 15 \
  --retry-all-errors \
  --retry-delay 2 \
  http://127.0.0.1/health