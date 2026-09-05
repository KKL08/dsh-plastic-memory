# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) with pre-release tags while the host
(DeepSeek Harness) is itself in pre-release.

## [Unreleased]

### Changed
- The host contract check now boots the host a second time on the same home
  and reads the restored memory back, so a restore that only lived in memory
  cannot pass.

### Fixed
- A memory whose name contains `.tmp-` (for example `cache.tmp-notes`) was
  treated as an atomic-write leftover on reload: it vanished from the table and
  the file was removed once it looked stale. Only the exact temp suffix written
  by the store is cleaned up now.
- Saving one memory refreshed the change fingerprint for the whole library, so a
  manual edit to another file made during that save was never picked up and
  could be overwritten by the stale in-memory copy. A save now only calibrates
  the files it touched.
- Two concurrent promotions to `AGENTS.md` could both report success while only
  one line landed; appends on the same writer are now serialized.
- `AGENTS.md` de-duplication matched substrings, so an entry that was a prefix
  of an existing one was silently skipped. Entries are compared as whole lines.
- A semantic-scan finding listing the same memory id twice was accepted as a
  two-sided conflict, and resolving it with keep-left deleted the memory the
  user asked to keep. Duplicate ids are collapsed at parse time and malformed
  pending decisions are rejected and cleared instead of acted on.

## [0.1.0-beta.3] - 2026-09-04

### Added
- Stable machine-readable codes on tool results: `code` on rejected saves,
  `{ code, text }` warnings and scan notes, `recommendationKinds` on health,
  `noteCode` on search, `missing` on snapshot creation and `alsoCleared` on
  confirm. The authoritative list lives in `src/contract-codes.ts`.
- Typed errors: `RecordNotFoundError`, `FrontmatterError` (with a code,
  including `yaml-parse` for a fence that is not valid YAML) and
  `TypeRegistryError`.
- A reproducible build for contributors: `pnpm install && pnpm typecheck && pnpm
  test && pnpm build` works from a clean clone; dev dependencies resolve from
  npm.
- Contract tests that build the nine tools with the real `defineTool` and check
  every result against the host's lossless-JSON rule; property-based tests for
  slugs, reserved names and query terms; coverage reporting.
- Two real-host checks anyone can run without an API key:
  `pnpm host:smoke` (install the packed plugin into a fresh, pinned dsh host)
  and `pnpm host:contract` (drive the nine tools through the real host).

### Fixed
- Tool results could contain `undefined` values that the host rejects as
  non-lossless JSON (seen on `memory_snapshot show` after a record was removed);
  every result now passes through one outbound boundary.
- `slugifyName` was not idempotent at the 40-character cut and could produce a
  file name ending in `-`.
- The output boundary dropped an own key named `__proto__` and rewrote the
  result's prototype instead; such keys are now kept as the host keeps them.

## [0.1.0-beta.1] - 2026-09-02

First public beta on npm (`dsh plugin --profile web add dsh-plastic-memory@beta`).
