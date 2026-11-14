# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) with pre-release tags while the host
(DeepSeek Harness) is itself in pre-release.

## [Unreleased]

### Added
- A graphical interface in DeepSeek Harness. The Memory page in the left nav
  lists the scopes (All, Global, each project) with their health score,
  checkup controls and three views: To do, Browse and Recently deleted. It
  works without an open chat once DeepSeek Harness has at least one, and
  rereads the memory files each time it opens. Its nav icon shows an amber
  dot when something waits for your decision and a red triangle when a
  secret was found.
- To do sorts what needs you into High priority (secrets, unreadable files),
  Waiting on you (conflicts, promotion candidates, budget overflows) and
  Suggested cleanup (expired, long unconfirmed, too long, duplicate, in the
  wrong scope, unclear, replacing a memory that is gone). Each card says why
  it is there and what each choice does, is handled in place and can be
  undone where the action allows; "Don't remind me" hides a suggestion until
  the memory changes.
- Browse groups memories by type, or for All by when they last changed.
  Recently deleted keeps memories for 14 days with restore, permanent delete
  and search, and says which memory won when a conflict ruling removed one.
  Deleting anywhere in the interface asks first.
- Edit on a memory lets you rewrite it yourself or tell the model what to
  change. Select tidies 2–20 memories of one scope at once, and duplicate
  cards offer Merge. The model proposes each change and asks when it lacks
  information, nothing is written until you have reviewed it, and the whole
  batch can be undone.
- Conflict cards come with a suggestion: the model reads both memories and the
  conversations they came from, then proposes to merge them, keep one or keep
  both, or drafts a plan from your own words. Nothing is written until you
  adopt, and adopting can be undone. Conflicts with `AGENTS.md` / `CLAUDE.md`
  use the same card and can be settled from any conversation.
- Suggestions cost one extra model call per new conflict after a checkup;
  automatic checkups prepare at most 10 per run, the rest get Suggest on the
  card. Memories holding a high-risk secret are never sent to the model.
- A Memory tab in each chat's right sidebar shows which memories the chat
  brought in, their share of the budget and what the model saved or rewrote;
  conflicts among them can be settled there. A card under each turn that saved
  memories offers promotion when the model marked one as fitting every
  project, and shows rewrites before and after with Undo for 14 days. Memory
  tool calls fold into one line in the chat, with secrets masked. A Memory
  button next to the composer shows the share of the context window.
- A settings page in the plugin manager covers scenes and types, the budget
  and overflow handling, source lookup, reminder sensitivity and the
  promotion target. It writes the same `cordis.patch.yml` and applies without
  a restart. `accent` picks the theme color: Ella (default) or Blue Whale.
- Automatic checkups: each scope can be checked every 1–90 days or only by
  hand, the default. They run in the background while DeepSeek Harness is
  open, on its default model. Every checkup reports roughly how many tokens
  it used.
- Chinese word segmentation for `memory_search` through the optional
  dependency `@node-rs/jieba`, so long Chinese questions match by word. Where
  it cannot be installed, Chinese search falls back to two-character segments
  and logs one warning. `search.userDictionaryPath` (config file only) adds
  your own words.
- `memory_search` takes `match`: `any` (default) or `all`, for memories
  containing every keyword. Results say how many matched when not all are
  shown, and each hit carries its file's absolute path and, when it lacks some
  keywords, which ones it matched.
- Custom types take an optional `howToUse`: how the model should use these
  memories once they are brought into a chat.

### Changed
- Requires DeepSeek Harness v0.2.1-rc.2 or later, the first version with the
  interface slots the plugin uses. Older hosts refuse to install or start this
  release; stay on 0.1.1-beta.5 there.
- Memories are read from their files on demand; the plugin keeps no copy of
  the library in memory and no longer loads it at start-up.
  `pnpm bench:storage` measures storage timings on your machine.
- Each scope directory gains `.archive/` (forgotten and superseded memories,
  kept 14 days, hidden from DeepSeek Harness's grep tool), and the root gains
  `.state/` (snapshots, pending decisions, scan cache, recall statistics,
  checkup settings and records). Memory files are used in place. Snapshots
  and pending decisions are imported once from DeepSeek Harness's KV store
  and removed there; recall statistics and the scan cache start fresh.
- Hand-written memory files need only `name` and `type`, and timestamps accept
  plain dates and ISO 8601.
- The model asks before rewriting or replacing a memory you edited by hand:
  `memory_save` returns the current text and needs `force: true` after you
  agree. A rewrite of a memory that changed meanwhile is rejected with the
  current content.
- `validFrom` / `validTo` are local `YYYY-MM-DD HH:mm`, or a date alone, both
  in memory files (UTC ISO timestamps before) and in `memory_save` (epoch
  milliseconds before); impossible dates and passed deadlines are rejected.
  Existing files are converted at the next write, rounded so nothing expires
  earlier. Versions before 0.2.0 cannot read files in the new form.
- Scenes replace the three fixed templates: a scene is the set of types the
  model can add, picked from the five built-in types, the presets `procedure`
  and `decision`, and your custom types. General (`template: custom`) stays
  fixed; Coding and Office can be edited or removed, and `scenes` holds up to
  five scenes besides General, each with 1 to 8 types. Memories of every type
  stay injected and searchable whichever scene is current. The default scene
  is now General; pick Coding on the settings page to keep `procedure`.
- Custom types now apply only in scenes that include them, and no config is
  migrated: after upgrading, tick your `customTypes` into a scene on the
  settings page. With `template: custom`, create a new scene, since General is
  fixed.
- The presets can be edited, removed (`removedPresetTypes`) and restored, and
  custom types renamed; when a renamed or removed type has memories, you
  choose whether they follow, stay or move to Recently deleted.
- Type definitions are clearer and reach beyond work: `profile` covers the
  person, `preference` how you want work done, `project` also personal
  matters, `reference` also where things are kept or whom to ask. Saving
  guidance asks for the reason behind a rule, synonyms and bilingual aliases
  as tags, and no fast-changing details. Existing memories are not rewritten.
- The memory snapshot is its own message, separate from DeepSeek Harness's
  shared runtime context, so changes from other plugins do not resend it.
  Index lines end with the file path, and the snapshot says how to use each
  type and that memories never start a task.
- Settings changed in the interface or `cordis.patch.yml` reach running chats
  at their next step; only settings that shape the snapshot refresh it.
- Memories over `snapshotTokenBudget` are injected in full by default:
  `snapshotOverflow: relax` reports each 25 % step over the budget on the
  memory page; `strict` keeps the cut-off.
- Tokens are estimated per character, calibrated against DeepSeek's tokenizer
  (0.6 per CJK character, 0.3 per other). The default 4,000 now fits about
  6,700 Chinese characters, up from 2,700; English-heavy memories estimate
  higher and may cross the budget.
- Checkups examine every memory, in batches of about 30,000 tokens (the first
  200 memories before), and say when a scope needed several batches, since
  conflicts across batches can be missed.
- Checkups compare each project's memories with that project's own
  `AGENTS.md` / `CLAUDE.md`, the files a new conversation there would read,
  and global memories with the global ones. Checkups of everything and
  automatic checkups cover every project, and the result says so when the
  files were cut off or couldn't be read.
- `memory_search` ranks whole-word matches above partial ones and name,
  summary and tags above content. Notes on weak matches or types without
  memories are signals for the model. Long memories and lower-ranked hits
  return an excerpt.
- A memory holding a secret is deleted at once by `memory_forget` or a
  conflict ruling, with its copies in global and the current project, and
  keeps no recoverable copy; every snapshot replaces it with
  `[redacted: secret]`. `memory_save` refuses a suspected secret (a password
  or `api_key` without vendor format) until you confirm and it is resent with
  `force: true`.
- Governance tools act on global and current-project memories only; another
  project's memory needs `allowCrossWorkspace: true`. `memory_source` output
  includes tool results.
- In subagent sessions `memory_save` is the only writing tool, and only while
  governance is on. What it saves stays pending in the current project: not
  injected into the main session, ranked last in search, marked unconfirmed
  and traceable to the delegating session. A subagent can create `knowledge`
  and `project` memories the scene includes, without `supersedes` or `force`,
  up to `subagent.maxSavesPerSession` (default 10) per session, and update
  only pending memories it saved. The main session accepts one with
  `memory_confirm` `accept-subagent`, a `memory_save` update, a promotion or
  an edit on the memory page. `memory_source` in a subagent traces only
  memories that session saved.
- Testing: `pnpm host:contract` now also covers hand-written files, the grep
  tool, subagent writes on a real child session, `/memory` commands, the
  checkup timer, the interface slots, and that the installed plugin reads
  instruction files the way DeepSeek Harness does. `pnpm host:smoke` also
  loads the package without optional dependencies. CI adds `pnpm lint`,
  checks that the browser bundle and both READMEs ship, and runs a search
  evaluation set.

### Fixed
- Two memory files with the same id: the older one was deleted when the
  library loaded. Both are now kept and `memory_health` reports the
  duplicate.
- A vendor-format key (`sk-`, `ghp_`, AWS, PEM private key) typed into a
  memory file was injected as is. It is now masked as `[已隐藏]` in the
  snapshot, search results, checkups and the interface.
- Keys quoted in a `memory_forget` reason, a snapshot description, a conflict
  summary or a parse error were logged and saved as is; they are now masked.
- Promoting a memory with a secret to `AGENTS.md` copied the secret there and
  is now refused. An unreadable `~/.dsh/AGENTS.md` was replaced on promotion
  and is now left alone.
- A suspected secret such as `password: …` or `api_key=…` kept the health
  check red with no way to clear it. Only vendor-format keys do now.
- A conflict settled by keeping both memories came back at the next scan. The
  verdict is now remembered until either side changes, conflicts carried over
  from 0.1.x included, and a conflict is listed only once.
- Checkup findings named memories by internal ids such as `mem_xxx`.
- On DeepSeek Harness v0.2.2-rc.1 the plugin page showed the README's images
  as broken; they now ship with the package.

### Removed
- The `commitment` and `person` types: Office now adds only `decision`, which
  also covers commitments. Existing memories of these types are still read,
  but no scene can add new ones.

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
