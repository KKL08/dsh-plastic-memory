# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Memory files can hold new optional keys that upcoming features will use:
  when a fact took effect, which sessions a memory came from and how it last
  changed, related memories, the memories a decision depends on, a
  per-memory recall setting and a lock. This version reads and keeps them
  but does not write them yet.
- A memory folder can be shared with 0.2.0: 0.2.0 keeps the new keys when
  it edits a file, and files without them read and write exactly as before.
- Testing: `pnpm host:contract` also checks the host interfaces upcoming
  features rely on: session queries, idle and archive state, sessions from
  an earlier host process, forked sub-agents and messages delivered by the
  plugin.
- Testing: the test suite runs the published 0.2.0 package on the same
  memory folder as this version.
- Testing: seeded random sequences run several writers over the same memories
  and check that no write is lost, every write finishes and undoing one write
  leaves the others as they were.

### Changed
- The recall options of a memory type are renamed after what each chat
  carries: Always, Search and Passive are now Full text, Summary and Brief
  index (全文, 摘要 and 简单索引 in Chinese). The settings page, the side
  panel and the guide use the new names; the values in configuration
  (`core`, `search`, `passive`) stay the same.
- Each change to a memory (its snapshot, the memory file and the record
  that lets you undo it) now runs as one step under the memory folder's
  write lock. If the lock stays busy, the change fails as a whole and can
  be retried, instead of stopping partway.

### Fixed
- A memory file whose timestamp was a number outside the range of a date was
  read as normal, and the next change to that memory failed. Such files now go
  to quarantine, like other malformed files.
- A memory folder that could not be read, for example after a permission
  change, was treated as empty: the chat went without those memories for
  the rest of the session, `MEMORY.md` was rewritten without them and
  dismissed over-budget reminders came back. The chat is now told the
  memories could not be read, nothing is rewritten, and the next message
  reads the folder again.
- Submitting a memory card on the memory page could undo tags edited in the
  file while the card was open. A card now asks for a refresh when the
  memory's name, type, tags, summary or content changed after it opened.
- After a checkup, a project with no memories of its own was reported as never
  semantically scanned, and its own automatic checkup setting and checkup
  history could be removed. The health page now says the project has no
  memories of its own yet, and the setting and history stay until the project
  folder is gone. A folder on a drive that is not connected counts as still
  there.
- A full checkup no longer clears the stored semantic scan results of a
  project that has no memories at the moment, for example when they are all
  in recently deleted. The results stay until the project folder itself is
  gone.
- With the desktop app and `dsh web` open on the same memories, promoting
  memories to `AGENTS.md` in both at the same time could drop some of the
  promoted memories. Promotions now take turns under the memory folder's
  write lock.
- If a project memory was deleted for good while an undo was restoring it,
  the undo could still write it back, bringing back a deleted secret or
  removing a global memory with the same id. Restores now check each memory
  again right before writing it back and skip it once it has been deleted.
- After merging two conflicting memories into one, the only way to undo the
  merge was the result card, which went away once you left the view;
  Recently deleted could bring back only the merged-away memory. Its row
  there now also has Undo this merge, which puts both memories back as they
  were and returns the conflict to Waiting on you.
- Undoing something that had already been undone or had expired showed an
  internal message with an id, in Chinese even in the English interface. It
  now says plainly that nothing was undone.
- Conflict results and their notes on the memory page and in the side panel
  now name the memories ("Kept “…”", "“…” was deleted") instead of calling
  them A and B, since the deleted one is no longer on screen. A long name in
  the result label is cut off with an ellipsis.
- In the side panel, when the memory a suggestion would delete holds a
  secret, the note said it would move to Recently deleted. It now says the
  memory will be deleted permanently, as the memory page already did.
- If the page reloaded, the connection dropped or the app answered with a
  temporary error while the memory page was checking its action channel,
  the following actions ran as `/memory` commands and left rows in the
  conversation. The page now checks once more and, if that fails too, fails
  that action and checks again on the next one.
- When a session could not run a memory page action, for example because it
  was open in another window, the page said only that the session was
  unavailable. The message now carries the app's own error code and text.

## [0.2.0] - 2026-11-21

First stable release of the 0.2 line. It includes every change from the
0.2.0-beta.1 to 0.2.0-beta.4 releases, plus the changes below. Requires
DeepSeek Harness v0.2.2-rc.1 or later.

### Changed
- Memories are saved in a clearer shape: the main point first, then the
  reason or source in the same paragraph, and other memories referred to by
  name. Existing memories are not rewritten. If you edited the preset
  `procedure` or `decision` type, your copy keeps the old examples until you
  restore it in settings.
- The `reference` type now covers where project materials live (paths,
  links, documents). Its summary is shown in the conversation, so the model
  can go straight to the location.
- Long memories on the memory page are folded to six lines, with "Expand"
  to read the rest.
- A memory you edit under Browse is marked "Rewritten".
- Development and CI test against DeepSeek Harness v0.2.2-rc.5; v0.2.2-rc.1
  is still the oldest supported version.

### Fixed
- The memory page no longer adds a "memory" row to the conversation for
  each action.
- From a project, the model can no longer turn a project-only rule into a
  global memory unnoticed: changing a global memory first returns a
  reminder, and is written only when resent with the code it gives.
- The memory page no longer shows full local paths, including in
  "Move to project…".
- With the desktop app and `dsh web` open on the same memories, each now
  picks up the other's changes without a refresh.
- A project whose memories were all deleted keeps its own checkup setting
  and is left out of the "All" status line.
- A memory that replaces an older one (`supersedes`) is no longer flagged as
  a duplicate of it.

## [0.2.0-beta.4] - 2026-11-18

### Fixed
- Model features on the memory page, such as rewriting a memory, and
  checkups (manual and automatic) failed with a 400 error
  (`MissingSessionID`) on providers that route requests by conversation,
  such as OpenCode Go. These requests now carry a session id, as chat
  requests do.

## [0.2.0-beta.3] - 2026-11-16

### Added
- `memory_save` updates can change just part of a memory: pass `edits`, each
  an exact `oldString` from the current text and its `newString`. The rest of
  the memory stays as it was, and if any edit does not match exactly once, the
  whole update is rejected and nothing is written. The chat card shows the
  edited memory the same way as a full rewrite.

### Changed
- Memories you edited by hand are no longer locked against model updates.
  When a conversation calls for a change, the model updates them like any
  other memory, without asking first or needing `force`. The "hand-edited"
  note on such memories is gone; a mark left in an existing file is ignored
  and dropped the next time that memory is written.

## [0.2.0-beta.2] - 2026-11-15

### Added
- A write lock on the memory folder that works across processes. With the
  desktop app and `dsh web` open on the same memories, writes now take turns,
  so one side can no longer overwrite what the other just saved. A write that
  cannot get its turn within 10 seconds fails with a clear error. On a Node
  build without `node:sqlite`, writes keep the protection they had within a
  single process. The lock only covers processes running this version or
  later, so update every place that opens the same memories.

### Fixed
- Cleaning up an expired checkup claim could remove one that had just been
  renewed, letting two checkups run on the same scope.
- Deleting a memory while it was being moved or restored could report it as
  missing; the delete now finds it.
- A snapshot could have a memory redacted when that memory had only been
  promoted to another scope; it is now left intact unless it holds a secret.
- A snapshot taken while a memory with a suspected secret was being deleted
  for good could keep the secret if another file in that scope was
  unreadable; it is now redacted.
- Forgetting a memory that was edited after it was read removed the newer
  text; it is now skipped and reported.
- Restoring a snapshot whose entries already matched the files could mark
  those files as its own and remove them when the restore was undone.

### Changed
- Development and CI build against DeepSeek Harness v0.2.2-rc.3, so the
  project compiles with the newest host release; CI keeps running the full
  check on v0.2.2-rc.1.
- Memory files are parsed once and reused until they change on disk, which
  makes reading memories, search and checkups faster on larger memory
  folders. Files edited by hand or by git are picked up on the next read.
- Promoting a memory that was edited after it was read now skips it and
  reports it as skipped, instead of moving the newer text.
- The test suite reruns the snapshot tests with the write lock unavailable,
  and searches interleavings of concurrent writes, checking each outcome
  against a serial order.

## [0.2.0-beta.1] - 2026-11-15

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
  use the same card and can be settled from any conversation. When the memory
  records a later change, the suggestion also asks you to update that part of
  the file; the plugin never edits it.
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
- Requires DeepSeek Harness v0.2.2-rc.1 or later, which has the interface
  slots the plugin uses and shows the plugin's own description on the plugin
  page. Older hosts refuse to install or start this release; stay on
  0.1.1-beta.5 there.
- The plugin page shows a short introduction (what the plugin does, its
  design principles and how to get started) instead of the whole README.
- Memories are read from their files on demand; the plugin keeps no copy of
  the library in memory and no longer loads it at start-up.
  `pnpm bench:storage` measures storage timings on your machine.
- Each scope directory gains `.archive/` (forgotten memories, kept 14 days,
  and superseded ones, kept with the memory that replaced them; hidden from
  DeepSeek Harness's grep tool), and the root gains
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
  Existing files are converted the first time you send a message or save in
  that scope, rounded so nothing expires earlier. Versions before 0.2.0
  cannot read memories with a validity period in the new form, so profiles
  that share a memory folder should upgrade together.
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
  duplicate; the next save, edit or deletion of that memory keeps only the
  copy it writes.
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
  verdict is now remembered until either side changes, and a conflict is
  listed only once. Conflicts settled as keep-both or false positive under
  0.1.x were not recorded and may be reported once more after upgrading.
- Checkup findings named memories by internal ids such as `mem_xxx`.

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
