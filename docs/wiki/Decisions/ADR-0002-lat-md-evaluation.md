# ADR-0002: Defer lat.md Adoption, Adopt Concepts Natively

## Status
Accepted

## Date
2026-04-03

## Context
[lat.md](https://github.com/1st1/lat.md) (v0.11.0, ~857 GitHub stars) is a CLI tool by Yury Selivanov that creates a `lat.md/` directory of interconnected markdown files forming a queryable knowledge graph for AI agents. It proposes wiki-style `[[links]]`, source code backlinks (`// @lat:`), link validation (`lat check`), test traceability (`require-code-mention`), semantic search via embeddings, and an MCP server.

The Mantle monorepo was evaluated for adoption because of a real documentation integrity problem: 21 broken wiki link occurrences in AGENTS.md referencing pages deleted in March 2026. This prompted analysis of whether lat.md would improve AI-assisted development.

### Evaluation Summary
A ralplan consensus analysis (Planner, Architect, Critic) was conducted with 20+ web searches. Three options were evaluated:

- **Option A**: Skip entirely, fix natively
- **Option B**: Adopt concepts selectively, no tool install
- **Option C**: Full lat.md adoption

## Decision
**Option B: Adopt lat.md concepts selectively within the existing Mantle ecosystem.** No lat.md tool installation.

Specifically:
1. Expanded `validate-doc-sync.sh` Check #7 to scan AGENTS.md and CLAUDE.md for broken `docs/wiki/` links (previously only scanned within `docs/wiki/` files)
2. Removed 21 broken wiki link occurrences from AGENTS.md, replacing with references to `mantle check` rules and existing wiki pages
3. Added `mantle check docs` subcommand to the CLI for framework-level documentation link validation across all instances

### Decision Drivers
1. **Doc-code linkage validation was a scope gap, not a tooling gap.** The existing `validate-doc-sync.sh` already had wiki link validation (Check #7) but scoped only to `docs/wiki/` files. Expanding to AGENTS.md/CLAUDE.md was a ~10-line fix.
2. **Hook and MCP conflicts.** lat.md installs UserPromptSubmit and Stop hooks; the monorepo already runs 7+ OMC hooks at those lifecycle points. lat.md's MCP server would be a second MCP alongside Mantle's 20+ tool server.
3. **Parallel documentation surfaces.** Adopting lat.md would create a fourth documentation layer (`lat.md/` alongside CLAUDE.md, AGENTS.md/wiki, graphrag) with no reduction in existing layers.
4. **Maturity risk.** 0.x version, single author, <1 month old, no published benchmarks. Inconsistent with Mantle's 65-check quality standards.

### Alternatives Considered

**Option A (Skip entirely)** was rejected because the dead link problem was real and warranted action. The 21 broken links had persisted 8+ days without detection.

**Option C (Full adoption)** was rejected because:
- The unique value (semantic search) is narrow for a ~30-Lambda codebase where agents don't struggle to find code but rather with stale references
- The write-back loop problem (agents updating docs after tasks) is genuine but addressable through CI-blocking validation rather than a parallel documentation system
- `doc-code-mapping.json` already declared `wikiLinkValidation`, `codePathValidation`, and `orphanPageValidation` schemas. The gap was in implementation scope, not tooling

### Steelman for Option C (recorded for intellectual honesty)
The strongest case for lat.md is the **write-back loop**: wiki pages accumulated drift over months, leading to bulk deletion of 31 pages, which cascaded to 7+ more deletions, and AGENTS.md was never updated. This reveals strong read-side infrastructure but weak write-side automation. lat.md's agent write-back model addresses this directly. However, CI-blocking validation (`mantle check docs`) provides detection at merge time, which is sufficient to prevent the drift pattern from recurring.

## Consequences

### Positive
- Zero new dependencies, zero hook conflicts
- Documentation link validation now runs at two levels: instance-specific (`validate-doc-sync.sh`) and framework-level (`mantle check docs`)
- AGENTS.md is accurate again; all wiki links resolve
- Anti-patterns table now references `mantle check` rule names instead of deleted wiki pages

### Negative
- No semantic search over documentation (agents still use grep/read)
- No automatic agent write-back to documentation after tasks
- If lat.md becomes an industry standard, migration cost increases with every wiki page added

## Enforcement
- `validate-doc-sync.sh` runs in CI (`pnpm run validate:doc-sync`)
- `mantle check docs` available as a CLI subcommand for all instances
- This ADR serves as the re-evaluation trigger

## Re-evaluation Trigger
Revisit this decision if:
1. lat.md reaches version 1.0 with stable API
2. The doc-code drift pattern recurs within 3 months of this fix (by 2026-07-03)
3. lat.md gains institutional backing (for example, Linux Foundation or major vendor adoption)

## Related
- Mantle convention checks (`~/.claude/principles/mantle-checks.md`), covering C1-C95
- `validate-doc-sync.sh` Check #7, expanded to scan AGENTS.md/CLAUDE.md
- `mantle check docs`, new CLI subcommand added alongside this ADR
- [lat.md repository](https://github.com/1st1/lat.md), the evaluated tool
