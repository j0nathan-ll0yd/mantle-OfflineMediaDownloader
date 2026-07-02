#!/usr/bin/env bash
# B10 behavior-only backstop for OpenSpec specs.
#
# OpenSpec specs (openspec/specs/**/spec.md) describe BEHAVIOR/INVARIANTS only. Field-level
# shapes are owned by the Zod schemas / OpenAPI / GraphRAG metadata (the "machine tiers").
# A spec that restates a schema field set is a boundary violation (see openspec/project.md
# authority hierarchy and OMD-specific spec fences).
#
# This is a lightweight heuristic backstop, not a parser: it flags specs that contain
# Zod-shaped signatures. Run manually or wire into CI later. Exit 1 on any hit.
#
# Usage: scripts/check-openspec-behavior-only.sh

set -euo pipefail
cd "$(dirname "$0")/.."

specs_glob="openspec/specs"
if [ ! -d "$specs_glob" ]; then
  echo "No $specs_glob directory; nothing to check."
  exit 0
fi

# Zod-field signatures that should never appear in a behavior-only spec.
# (Backticked code spans naming a schema by name are fine; actual z.* field definitions are not.)
pattern='z\.object\(|z\.string\(\)|z\.number\(\)|z\.boolean\(|z\.array\(|: *z\.'

hits=$(grep -rEn "$pattern" "$specs_glob" --include='spec.md' || true)

if [ -n "$hits" ]; then
  echo "✗ B10 behavior-only violation: OpenSpec spec(s) appear to restate Zod field shapes."
  echo "  Specs describe behavior; defer field shapes to the owning schema (cite it, don't restate it)."
  echo
  echo "$hits"
  exit 1
fi

echo "✓ B10 behavior-only: no Zod field-shape signatures found in openspec/specs/**/spec.md"
