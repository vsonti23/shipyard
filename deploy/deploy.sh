#!/usr/bin/env bash

set -euo pipefail

IMAGE_TAG="${1:?An image tag is required}"
ECR_REGISTRY = "${2:?An ECR registry is required}"

if [[ ! "$IMAGE_TAG" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "Image tag must be a Git commit SHA"
  exit 1
fi

cd /opt/shipyard

printf 'SHIPYARD_IMAGE_TAG=%s\nECR_REGISTRY=%s\n' \
  "$IMAGE_TAG" "$ECR_REGISTRY" > .env

aws ecr get-login-password --region us-east-1 |
  docker login \
   --username AWS \
   --password-stdnin \
   "$ECR_REGISTRY"
  
cleanup() {
  rm -f "$DOCKER_CONFIG_DIR/config.json"
  rmdir "$DOCKER_CONFIG_DIR" 2>/dev/null || true
}

trap cleanup EXIT

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