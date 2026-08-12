#!/usr/bin/env bash

# decrypt-cookies.sh
# Decrypts the SOPS-encrypted YouTube cookies used by the yt-dlp layer/container.
# Writes atomically (decrypt to a temp file, then mv) so a failed or empty
# decryption never leaves a 0-byte youtube-cookies.txt behind — a stale empty
# file would be skipped on the next run and baked into the Docker image.

set -euo pipefail

COOKIES_ENC="layers/yt-dlp/cookies/youtube-cookies.enc"
COOKIES_TXT="layers/yt-dlp/cookies/youtube-cookies.txt"

# -s (non-empty), not -f: a 0-byte file from any source is not a valid artifact.
if [[ -s "$COOKIES_TXT" ]]; then
  echo "Cookies already decrypted, skipping"
  exit 0
fi

if [[ ! -f "$COOKIES_ENC" ]]; then
  echo "ERROR: Encrypted cookies file not found: $COOKIES_ENC" >&2
  exit 1
fi

mkdir -p "$(dirname "$COOKIES_TXT")"

if ! command -v sops &> /dev/null; then
  echo "WARNING: sops is not installed — creating placeholder cookies for build"
  echo "# Placeholder — replace with real cookies via: pnpm run cookies:encrypt" > "$COOKIES_TXT"
  exit 0
fi

# Temp file lives beside the target so the mv is an atomic same-filesystem rename.
tmp="$(mktemp "${COOKIES_TXT}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

if ! sops decrypt --output-type binary "$COOKIES_ENC" > "$tmp"; then
  echo "ERROR: sops failed to decrypt $COOKIES_ENC" >&2
  echo "       SOPS_AGE_KEY_FILE must point to the age key (default: \$HOME/.config/sops/age/keys.txt)" >&2
  exit 1
fi

if [[ ! -s "$tmp" ]]; then
  echo "ERROR: sops produced an empty decryption of $COOKIES_ENC" >&2
  echo "       Refusing to write a 0-byte $COOKIES_TXT" >&2
  exit 1
fi

mv "$tmp" "$COOKIES_TXT"
trap - EXIT
echo "Decrypted cookies to $COOKIES_TXT"
