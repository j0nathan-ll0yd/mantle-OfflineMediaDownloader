#!/usr/bin/env bash

# Lint authored GitHub Actions workflows. The adjacent codegen-drift.lock.yml
# is generated from codegen-drift.md by GitHub Agentic Workflows; it contains
# Agent Workflow schema (for example, concurrency.queue) that actionlint does
# not support. Validate and regenerate that file with `gh aw` instead.

set -euo pipefail

workflow_files=()
while IFS= read -r workflow_file; do
  workflow_files+=("$workflow_file")
done < <(find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) ! -name 'codegen-drift.lock.yml' -print | sort)

actionlint "${workflow_files[@]}"
