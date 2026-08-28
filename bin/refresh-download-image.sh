#!/usr/bin/env bash

# refresh-download-image.sh
# Builds + pushes the StartFileUpload container-Lambda image (docker/Dockerfile.download)
# and repins docker/start-file-upload.pin.json to the pushed digest. It runs either in the
# isolated CI image-build lane (Docker CLI talking to an ephemeral non-rootless privileged
# DinD sidecar) or manually on the Mac Studio host -- see the plan:
# .omc/plans/omd-prebuilt-container-lambda-2026-08-16.md ("Image refresh (occasional)").
#
# Prerequisites:
#   - Docker (Colima context) with buildx and QEMU/binfmt for linux/amd64 emulation
#     (this fleet is arm64; the Lambda runtime is x86_64).
#   - ECR login: aws ecr get-login-password --region us-west-2 | \
#       docker login --username AWS --password-stdin 514454346828.dkr.ecr.us-west-2.amazonaws.com
#   - AWS credentials with ecr:GetAuthorizationToken + push access to the
#     staging/start-file-upload repository.
#
# Run: ./bin/refresh-download-image.sh
#
# CI automation note: update-ffmpeg.yml and update-yt-dlp.yml invoke this script on the
# `image-build` lane, then push the pin commit with the USER-provisioned fine-grained
# OMD_REFRESH_PAT (Contents:write on this repo only). A github.token push cannot be used:
# GitHub intentionally does not re-trigger `on: pull_request` workflows from that token.
# Other Dockerfile/layer/bundle changes still require an explicit refresh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_ROOT"

ECR_REGISTRY="514454346828.dkr.ecr.us-west-2.amazonaws.com"
# The ECR repo is named ${module.core.name_prefix}/start-file-upload, and name_prefix ==
# var.environment == the deploy stage ("staging") -- NOT the deprecated resource_prefix
# customVariable ("stag"/"prod"), which is S3-bucket-naming-only. This script is
# staging-only per allowedStages, so the stage is fixed here.
STAGE="staging"
ECR_REPO="${STAGE}/start-file-upload"
IMAGE="${ECR_REGISTRY}/${ECR_REPO}"

DOCKERFILE="docker/Dockerfile.download"
BUNDLE="build/lambdas/StartFileUpload/index.mjs"
PIN_FILE="docker/start-file-upload.pin.json"
META_FILE="$(mktemp -t sfu-meta.XXXXXX.json)"
trap 'rm -f "$META_FILE"' EXIT

if ! command -v docker &> /dev/null; then
  echo "ERROR: docker is required (Colima context). See this script's header." >&2
  exit 1
fi

git_short_sha="$(git rev-parse --short HEAD)"
tag="sha-${git_short_sha}"

echo "==> Decrypting YouTube cookies"
./bin/decrypt-cookies.sh

echo "==> Building the app bundle (same bundler as CI: mantle build --skip-container)"
pnpm build:ci

if [[ ! -f "$BUNDLE" ]]; then
  echo "ERROR: $BUNDLE was not produced by pnpm build:ci." >&2
  exit 1
fi

echo "==> Building + pushing ${IMAGE}:${tag} (linux/amd64)"
# --provenance=false --sbom=false: the docker-container buildx driver (needed for
# cross-building linux/amd64 on this arm64 fleet) attaches provenance/SBOM attestations
# by default, which turns the pushed artifact into an OCI image INDEX rather than a
# single image manifest. AWS Lambda container images must be a single-arch manifest;
# an index digest would produce an undeployable pin. Disable both.
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  -f "$DOCKERFILE" \
  --push \
  -t "${IMAGE}:${tag}" \
  --metadata-file "$META_FILE" \
  .

digest="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${META_FILE}','utf8'))['containerimage.digest'])")"
if [[ -z "$digest" || "$digest" == "undefined" ]]; then
  echo "ERROR: could not read containerimage.digest from ${META_FILE}." >&2
  cat "$META_FILE" >&2
  exit 1
fi

echo "==> Verifying the pushed artifact is a single image manifest, not an index"
manifest_type="$(docker buildx imagetools inspect "${IMAGE}@${digest}" --raw | node -e "
  let data = '';
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => { console.log(JSON.parse(data).mediaType); });
")"
case "$manifest_type" in
  *image.index* | *manifest.list*)
    echo "ERROR: pushed artifact ${IMAGE}@${digest} is an OCI image INDEX ($manifest_type)," \
         "not a single image manifest. AWS Lambda rejects indexes. This means" \
         "--provenance=false/--sbom=false did not take effect, or the buildx driver" \
         "in use still attaches attestations. Refusing to write an undeployable pin." >&2
    exit 1
    ;;
  *)
    echo "OK: pushed artifact is a single image manifest ($manifest_type)."
    ;;
esac

bundle_hash="sha256:$(sha256sum "$BUNDLE" | cut -d' ' -f1)"

echo "==> Writing ${PIN_FILE}"
cat > "$PIN_FILE" <<EOF
{
  "digest": "${digest}",
  "bundleHash": "${bundle_hash}",
  "tag": "${tag}"
}
EOF

echo "==> Committing the pin"
git add "$PIN_FILE"
git commit -m "chore(docker): repin start-file-upload image to ${tag}"

echo ""
echo "Done. Pushed ${IMAGE}:${tag} (${digest}) and committed ${PIN_FILE}."
echo "Push this commit (and the branch/PR it belongs to) to re-run CI's pin-integrity gate."
