# start-file-upload.pin.json

Pin record for the `StartFileUpload` container-Lambda image. Read by CI's Docker-free
pin-integrity gate (`.github/workflows/ci.yml`, Build job) and, once the mantle
framework change for `imageDigestFile` ships (worker-2, `feat/prebuilt-image-digest-mode`
on `mantle`), by `mantle deploy` itself. See the plan:
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

## Bootstrap state (this commit)

This file was bootstrapped, not produced by a real refresh:

- `bundleHash` is REAL — computed via `pnpm build:ci` against this commit's
  `src/lambdas/sqs/StartFileUpload/**` and its transitive imports.
- `digest` is a PLACEHOLDER (`sha256:PENDING-FIRST-REFRESH`). No image has been pushed
  to ECR for this bundle yet. CI's gate 2c (digest-exists-in-ECR) treats this placeholder
  as a soft warning, not a failure — gate 2c only runs when `AWS_ROLE_CI_ECR_READ` is
  configured, and gates 2a/2b (Docker-free, AWS-free) are the correctness-critical checks
  in Phase 0.
- The scheduled ffmpeg and yt-dlp workflows run `bin/refresh-download-image.sh`
  automatically on the isolated `image-build` lane. For any other image-input change,
  run it explicitly on an authorized Docker host to build + push the image and update
  this pin before deployment.

## `imageDigestFile` wiring status (step 6 of Phase 0)

`src/lambdas/sqs/StartFileUpload/index.ts` does **not** yet set
`defineLambda({ imageDigestFile: 'docker/start-file-upload.pin.json' })`. The installed
`@j0nathan-ll0yd/cli` (2.7.0, from GitHub Packages) predates the `imageDigestFile` field
add landing on `mantle` (`feat/prebuilt-image-digest-mode`, worker-2). Adding the field
today is a no-op either way (unknown `defineLambda` fields are not read), but leaving it
out avoids describing a contract this repo's installed CLI does not implement yet, and
keeps `mantle check` config validation honest about what's actually wired.

**Next step once mantle ships `imageDigestFile`:** bump `@j0nathan-ll0yd/cli` in this
repo, then add `imageDigestFile: 'docker/start-file-upload.pin.json'` to the
`defineLambda({...})` call in `src/lambdas/sqs/StartFileUpload/index.ts`. That flips
`mantle build`/`mantle deploy` into prebuilt-image mode (skip `docker build`, skip
`docker info`/ECR login/push, wire `image_uri_start_file_upload` from `pin.digest`,
fail closed if the digest is missing from ECR). Until then, CI's Build job is
Docker-free via `pnpm build:ci` (`mantle build --skip-container`, which mantle already
supports independent of `imageDigestFile`), and `mantle deploy` for `StartFileUpload`
still needs to run on a host with Docker (the Mac Studio) — i.e. Phase 0 unblocks CI,
Phase 1 (the mantle field, once wired here) unblocks deploy too.
