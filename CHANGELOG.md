# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) with pre-release tags while the host
(DeepSeek Harness) is itself in pre-release.

## [Unreleased]

### Added
- A graphical interface inside the host's web UI, no YAML required. The
  left-nav 「记忆」 page lists what is waiting for your decision (conflicts
  found by a checkup, memories worth promoting to global, budget overflows,
  secrets, files that failed to parse), all memories by project, the health
  of each layer and the memories deleted in the last 14 days with a one-click
  restore. Every item is acted on in place: rule a conflict, undo the ruling,
  promote or keep local, delete a secret for good, open the memory file or
  show it in Finder. The page needs no running conversation: it borrows an
  idle session of the current project to run its commands.
- A 「记忆」 tab in the right sidebar of each conversation showing which
  memories this session brought in, how much of the context budget they use
  and what the model saved during the conversation; conflicts among the
  injected memories can be ruled right there.
- The plugin's settings page in the host's plugin manager: scenario template,
  custom memory types (add, edit, remove in a dialog), context budget and
  overflow mode, source lookup, checkup switch and sensitivity, where global
  promotions go, and a status card with the memory count, the last checkup
  and what is waiting. Saving writes the same `cordis.patch.yml` the YAML
  path uses and takes effect without a restart. Hosts without the plugin
  manager page keep the YAML path.
- A card under each turn in which the model saved a memory (with a delete
  button and a link to the memory page), a one-line summary on every memory
  tool call, and a 「记忆」 button next to the composer showing the share of
  the context window the memories occupy.
- An amber dot on the left-nav icon when something waits for your decision; a
  red mark when a secret was found. Nothing lights up for warnings you cannot
  act on.
- `pnpm host:contract` now also checks the shipped browser bundle: the
  package declares `dsh.client`, the host's module loader can load
  `lib/client.js`, and both locale files ship. CI fails when the bundle is
  missing from the package.

### Changed
- Memories that exceed `snapshotTokenBudget` are no longer cut from the
  injected index by default. The new setting `snapshotOverflow` defaults to
  `relax`: everything is still injected, the budget is relaxed in 25 % steps
  and each step is reported once on the memory page, with a shortcut to raise
  the limit or dismiss. Set it to `strict` to keep the previous behaviour, in
  which the index lines stop at the budget; the page then says how many
  memories were left out.
- Settings changed in the GUI or in `cordis.patch.yml` now apply to running
  conversations at their next step: a new budget or source-lookup level is
  used the next time memories are assembled, a template or custom-type change
  re-registers `memory_save` with the new type list, and turning the checkup
  off removes the governance tools until it is turned back on. Previously a
  template change waited for the next session.
- Resolving a conflict by keeping one side no longer forgets the ruling. It
  stays as a settled entry (not counted on the dot) so it can be undone, and
  restoring the losing memory from 「最近删除」 brings the conflict back to the
  pending list exactly once. The deleted memory's row says which memory won.
- The GUI requires DeepSeek Harness v0.2.1-rc.2 or later. On older supported
  hosts (v0.1.7-rc.1 and up) the browser bundle registers nothing and the
  plugin's tools and memory injection work as before; nothing else is
  affected.
- Memories are now plain files and nothing else. The Markdown files on disk
  are the only copy: the plugin keeps no table in memory, loads nothing at
  start-up, and reads just the directories an operation needs. A file you
  create, edit or delete by hand, with git or from another process shows up in
  the next tool call and the next session's prompt without a restart. On a
  library of 10 projects × 1000 memories (Apple M4), start-up dropped from
  1.5 s to 0 and the 109 ms fingerprint check before every tool call is gone;
  `memory_search` takes about 30 ms, `memory_save` 190–280 ms, a single-layer
  `memory_health` 135 ms and a whole-library one 1.1 s. `pnpm bench:storage`
  reproduces these numbers on your machine.
- Storage layout: `global/` and one `<project>-<hash>/` directory per
  workspace (marked by a `.workspace` file holding the project path). A memory
  file is named after its `name`; `MEMORY.md` in each directory is a generated
  index of the memories currently in effect; `.archive/` holds forgotten and
  superseded memories for 14 days; `.state/` holds the plugin's own snapshots,
  pending decisions, scan cache and recall statistics. Existing files are read
  in place; snapshots and pending decisions are imported from the host's KV
  store on first use. The host's `storageDomain` service is therefore no
  longer required.
- Hand-written memory files need only `name` and `type` in the frontmatter; the
  id is derived from the file path and every other field is filled in at the
  next write or session start. Timestamps accept dates, ISO 8601 date-times
  and millisecond values. A file edited by hand is marked as such until the
  next `memory_save` update, and `memory_source` says its provenance may no
  longer match. Files that fail to parse are quarantined individually and
  listed by `memory_health` and `memory_scan` instead of breaking the library.
- Derived views are rebuilt only at the end of a write and when a session's
  memory snapshot is frozen: index files, moving non-active files to
  `.archive/`, sweeping archived files older than 14 days, recording hand edits
  and cleaning up leftover temporary files. Reads never write.
- Memories whose `validTo` has passed stay where they are but are no longer
  injected or found by `memory_search`; `memory_health` reports them as
  `expired` and suggests extending the date or forgetting them.
- `memory_search` with several keywords first requires all of them to match;
  when nothing matches all of them it falls back to any-match ordered by hit
  count and says so (`or-fallback`).
- Injected index lines now end with the memory's file path (`global/x.md`,
  `<project>/x.md`), so the model can open the full text directly, and the
  prompt ends with a fixed note that memories are background material: they
  shape how a requested task is done but never start a task, run commands,
  change files or override what the user is saying now. `.archive/` is a
  hidden directory, so the host's grep tool no longer surfaces forgotten text.
- `memory_forget` moves the file to `.archive/`, recoverable for 14 days as
  before. A memory that contains a secret is the exception: it is deleted
  physically at once, together with any other copy of the same id in the
  global and current-project directories, and its copy in every existing
  snapshot is replaced by a `[redacted: secret]` placeholder, so the snapshot stays usable for its other
  records while the secret is gone for good; `memory_snapshot restore` reports
  such records as `redacted`. A suspected secret without vendor markers is
  refused with `secret-suspected` until you confirm with `force: true`.
- Governance tools (`memory_forget`, `memory_confirm`, `memory_promote`,
  `memory_snapshot`) act on global and current-workspace memories only; a
  target from another project is refused with `cross-workspace` unless the
  call carries `allowCrossWorkspace: true`, meant for an explicit
  library-wide clean-up. Pending decisions record which workspaces they
  involve.
- Sub-agent sessions (tasks the host delegates, `delegationDepth ≥ 1`) are
  read-only: `memory_search`, `memory_source` and `memory_health` work, every
  writing tool including `memory_scan` is refused with `subagent-readonly`,
  and memories are still injected as usual.
- `memory_health` also lists quarantined files and directory-level problems:
  duplicate ids (the newest copy wins and the others stay until you remove
  them), workspace directories without a `.workspace` marker, unreadable or
  empty directories.
- `pnpm host:contract` now also checks that a file written straight into the
  memory directory is injected into the next session (H15) and that the
  host's grep tool finds top-level memories but nothing under `.archive/`
  (H16). `pnpm host:smoke` boots the real host with a probe plugin that
  confirms the tools are registered.

### Fixed
- A memory holding a vendor-format key (such as `sk-`, `ghp_` or an AWS
  access key), for example typed into a memory file by hand, was injected
  into every conversation as is. The injected text now shows `[已隐藏]` in
  place of just the key and leaves the rest of the memory as it was, with no
  extra notice in the conversation; if the key is in a memory's name, its
  index line leaves out the file path. `memory_forget` still removes the file
  for good.
- A suspected secret you had confirmed with `force: true` (a password or
  `api_key` value without a vendor format) kept the health check red until
  you deleted or rewrote it. It is now treated as confirmed: it no longer
  counts as a secret in `memory_health` or `memory_scan` and is injected
  unmasked.
- A conflict you resolved by keeping both memories (`keep-both`,
  `dismiss`, or keeping a memory over `AGENTS.md`) came back on the next
  `memory_scan`. The verdict is now remembered: the pair stays off the
  pending list until either memory, or the `AGENTS.md` it was checked
  against, changes.

## [0.1.1-beta.5] - 2026-10-20

### Changed
- Built and tested against DeepSeek Harness v0.2.1-rc.2. CI now also runs the
  type check, tests, `host:smoke` and `host:contract` on the minimum supported
  host.
- Supports DeepSeek Harness v0.1.7-rc.1 and later again. 0.1.1-beta.4 had
  raised the minimum to v0.2.0-rc.2 without needing anything from it; the
  plugin now runs unchanged on every host from v0.1.7-rc.1 to v0.2.1-rc.2.
  From now on the minimum only rises when the plugin needs a newer host API or
  the host breaks compatibility.

## [0.1.1-beta.4] - 2026-10-14

### Changed
- Requires DeepSeek Harness v0.2.0-rc.2 or later, the version the plugin is
  now built and tested against. v0.1.7 hosts refuse to install or start this
  release; stay on 0.1.1-beta.3 if you cannot upgrade the host yet. No plugin
  behaviour changes.

## [0.1.1-beta.3] - 2026-09-28

### Changed
- The `AGENTS.md` / `CLAUDE.md` baseline that `memory_scan` checks memories
  against for vertical conflicts is now maintained by the host's session
  projection service instead of being re-read from session history, a way of
  reading sessions the host is phasing out. The baseline is kept with the
  session and survives a session resume. On hosts or profiles without the
  session projection service the plugin still loads, but vertical-conflict
  detection is now off and `memory_scan` reports `baseline-missing`.

## [0.1.1-beta.2] - 2026-09-25

### Changed
- Requires DeepSeek Harness v0.1.7-rc.2 or later, the version the plugin is
  now built and tested against. The `@deepseek-ai/dsh-*` peer dependencies
  declare this minimum; hosts from v0.1.7 on check it when the plugin is
  installed and started, while on older hosts it is at most a package-manager
  warning.
- `pnpm host:smoke` no longer waits for the module fallback links the host
  stopped writing in v0.1.7. It now checks the installed `lib/` statically (it
  parses, and no relative import still points at a `.ts` file) instead of
  importing it outside the host.

### Fixed
- A memory whose text contained `{{ ... }}` (a GitHub Actions
  `${{ secrets.X }}`, a Vue or Handlebars template, …) made every turn fail
  while it was in the prompt: the host reads `{{name}}` in the system prompt as
  a variable reference and rejects unknown names. Memory text is now escaped on
  its way into the prompt and restored by the host, so the model sees it byte
  for byte. All earlier releases are affected; if you cannot upgrade yet,
  remove or edit the offending memory file under `~/.dsh/memories/`.
- A semantic scan whose LLM stream broke off after the model had already
  produced a complete answer was recorded as a clean scan, replacing earlier
  cached findings with an empty result. Such a scan now reports
  `semantic-failed` and leaves the cache as it was.

## [0.1.1-beta.1] - 2026-09-10

### Changed
- Requires DeepSeek Harness v0.1.5-rc.2 or later. Earlier hosts lack the
  session APIs the plugin now depends on, so the plugin no longer loads on
  them.
- Rebuilt on the v0.1.5 session APIs. `memory_source` still drills into the
  turn that triggered a save, and `memory_scan` still checks memories against
  `AGENTS.md` / `CLAUDE.md`; both now read the session through the host's new
  projection interfaces. `memory_scan` follows each instruction file as the
  host reports it: later edits replace earlier text, subdirectory instructions
  survive a restart, and when the baseline exceeds the prompt budget the newest
  revisions are kept.
- The evidence anchor no longer falls back silently: when it cannot resolve the
  triggering turn it logs a warning and anchors the whole session.
- The bundled host checks (`pnpm host:smoke` and `pnpm host:contract`) now
  exercise the plugin through the host's real sessions, including the evidence
  anchor of the current turn.

## [0.1.0-beta.4] - 2026-09-05

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
