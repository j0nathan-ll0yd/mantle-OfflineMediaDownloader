---
name: Codegen Drift Detector
description: Detects OpenAPI spec drift after backend schema changes and creates a cross-repo issue in the iOS repo

on:
  push:
    branches: [main]
    paths:
      - 'src/types/api-schema/**'
      - 'src/lambdas/api/**/index.ts'

engine:
  id: opencode
  model: copilot/gpt-4.1

permissions:
  contents: read

pre-agent-steps:
  - uses: actions/checkout@v4
  - uses: actions/checkout@v4
    with:
      repository: j0nathan-ll0yd/mantle
      path: ../mantle
      token: ${{ secrets.GH_CROSS_REPO_PAT }}
  - uses: actions/setup-node@v4
    with:
      node-version: '24'
  - uses: pnpm/action-setup@v4
  - run: pnpm install --frozen-lockfile
  - run: npx mantle generate openapi --output /tmp/openapi-check.yaml

safe-outputs:
  create-issue:
    target-repo: "j0nathan-ll0yd/ios-OfflineMediaDownloader"
    title-prefix: "[Codegen Drift]"
    labels: ["codegen-drift", "automated"]
    close-older-issues: true
    github-token: ${{ secrets.GH_CROSS_REPO_PAT }}
  add-comment:
    target: triggering
---

# Codegen Drift Detector

You are a drift detection agent for the Offline Media Downloader backend.

## Your task

A push to main just changed backend schema or API handler files. Check whether the committed OpenAPI spec is still in sync with the code.

The pre-agent-steps already generated the expected OpenAPI spec at `/tmp/openapi-check.yaml` by running `npx mantle generate openapi`. Your job is to compare it against the committed spec.

## Steps

1. Run `diff /tmp/openapi-check.yaml docs/api/openapi.yaml` to check for drift
2. If the files are identical (diff exits 0), call `noop` with message "No OpenAPI drift detected"
3. If there are differences (diff exits 1):
   a. Analyze the diff output to identify which endpoints or schemas changed
   b. Create an issue in the iOS repo with:
      - Title: "[Codegen Drift] OpenAPI spec out of sync — <brief summary of what changed>"
      - Body containing:
        - A summary of which endpoints/schemas were added, removed, or modified
        - The raw diff output in a collapsible details block
        - Instructions: "Run `bash Scripts/sync-openapi.sh` in `ios-OfflineMediaDownloader` to regenerate Swift types from the updated spec."
   c. Add a comment on this commit: "Codegen drift detected — an issue has been created in ios-OfflineMediaDownloader."

## Important

- Only create an issue if there is actual drift (the diff is non-empty)
- Be specific about which endpoints and schemas changed
- Do NOT suggest code changes — only flag the drift and point to the sync script
- If the diff command fails for any other reason (exit code 2), report the error via `noop`
