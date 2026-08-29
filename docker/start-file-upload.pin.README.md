# start-file-upload.pin.json

Pin record for the `StartFileUpload` container-Lambda image. It is read by CI's
Docker-free pin-integrity gate (`.github/workflows/ci.yml`, Build job) and by Mantle's
`imageDigestFile` deployment path. See the plan:
`.omc/plans/omd-prebuilt-container-lambda-2026-08-16.md`.

## Schema

```json
{
  "digest": "sha256:<ECR manifest digest>",
  "bundleHash": "sha256:<hex sha256 of build/lambdas/StartFileUpload/index.mjs>",
  "tag": "sha-<gitshort>"
}
```

- `digest` — the immutable ECR manifest digest `mantle deploy` wires into
  `image_uri_start_file_upload`. Authoritative; `tag` is a disposable handle only.
- `bundleHash` — sha256 of the exact `index.mjs` baked into that image. CI's gate 2a
  recomputes this from the current commit's `pnpm build:ci` output and fails the build
  on a mismatch. **Invariant:** both `bin/refresh-download-image.sh` and CI compute this
  from `mantle build --skip-container` (`pnpm build:ci`) — never a hand-rolled esbuild
  call — so both sides bundle identically for the same Mantle version.
- `tag` — a disposable, content-unique tag (`sha-<gitshort>`) used only because the ECR
  repo is `IMMUTABLE`; not consumed by the digest-based deploy path.

## Current enforcement

This is a real ECR manifest pin, produced by `bin/refresh-download-image.sh` and consumed
by `imageDigestFile: 'docker/start-file-upload.pin.json'` in the Lambda definition.
Mantle deploys the immutable digest and fails closed when it is absent.

The refresh script builds through the isolated `image-build` DinD lane, pushes a single
linux/amd64 manifest, and then runs that exact digest as an unprivileged, read-only,
networkless container. The smoke test checks the handler bundle, cookie readability,
ffmpeg/ffprobe, Deno, yt-dlp, and the matched jim60105 `bgutil:cli` plugin/provider pair
before this file can be rewritten or committed. `Dockerfile.download.dockerignore` limits
the remote builder context to the four local inputs the Dockerfile actually copies.

The scheduled ffmpeg and yt-dlp workflows run that refresh automatically and push the
generated pin commit back to their PR branch with the repo-scoped `OMD_REFRESH_PAT`. For
any other image-input change, run it explicitly on an authorized Docker host before
deployment. CI gates 2a/2b verify that the bundle and non-code inputs moved with this pin;
gate 2c verifies the digest in ECR when its read-only role is configured.
