# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) with pre-release tags while the host
(DeepSeek Harness) is itself in pre-release.

## [Unreleased]

### Added
- Memories can be changed straight from the memory list. Edit on a row
  lets you tell the model what to change or edit the text yourself, in the
  same panel pending cards now use for edits and merges, and both can be
  undone. Select lets you tidy 2–20 memories from one scope at once: the
  model proposes what to rewrite, delete or keep and asks when it lacks
  information, nothing is written until you have reviewed each change, and
  Undo all reverts the whole batch.
- A "Duplicate content" card that lists three or more memories now has
  Merge. It opens the same review panel as Select with the request filled
  in, so the model combines them into one and nothing is written until you
  have reviewed the changes.
- Subagent sessions can save memories with `memory_save` while governance
  is on. What they save lands in the current project as pending: it is not
  injected into the main session, ranks after other memories in search, and
  is marked as unconfirmed in index lines and search results. Each memory
  records the session that wrote it, its delegation depth, and the parent
  and root sessions, so a wrong memory can be traced to the task behind it.
- Subagents can only write `knowledge` and `project` memories the current
  scene includes, as observed or inferred, without `supersedes` or `force`,
  and can only update pending memories their own session saved.
  `subagent.maxSavesPerSession` (default 10) caps how many each subagent
  session can create.
- `memory_confirm` gains the `accept-subagent` action: the main session
  accepts a pending memory, which is then injected and searched like any
  other; rewriting it with `memory_save update` accepts it too. You don't
  have to go through them one by one: one reaches the usual promotion
  candidates only when the main session thinks it should be global, and
  memory cards label them as below.
- Memory cards label memories written by a subagent with their level and
  whether they are pending, accepted by the main session or edited by you.
  Editing or promoting a pending memory on the memory page accepts it, and
  so does promoting it with `memory_promote`.
- Settings gain an Appearance group with a theme color: Ella (the silver
  vine used so far, the default) or Blue Whale, which follows the DeepSeek
  Harness brand blue in light and dark mode. It is stored as `accent` and
  applies to every memory panel as soon as it is saved.
- The preset types `procedure` and `decision` can be edited and removed on
  the settings page, and restored later. A removed preset gets no new
  memories, while existing ones are still injected and searchable. Removed
  presets are stored in the new `removedPresetTypes` key; an edited preset
  is an entry of the same name under `customTypes`, as before.
- The base five types can be viewed on the settings page: their full
  definitions, read-only.
- Custom types take an optional `howToUse`: how the model should use these
  memories once they are brought into a chat. The settings page form has a
  matching field.
- `memory_search` takes `match`. The default `any` returns every hit,
  ranked as before; `all` returns only memories that contain every keyword.
  When `all` finds none, the result says so, shows how many memories each
  keyword matched and points to `any` for partial hits.
- Each `memory_search` hit that lacks some keywords says on its first line
  which keywords it fully matched, or that it matched only part of one or
  only a substring, so the model can compare hits at a glance. Hits that
  contain every keyword are not marked.
- Conflict cards now come with a suggestion. After a checkup finds a
  conflict, the model looks at both memories and the conversations they
  were saved from, then proposes to merge them, keep one, or keep both,
  with a one-line reason; a merge shows the combined text next to the
  originals. Adopt applies it and can be undone. Nothing is written until
  you adopt, and the three direct choices are still there.
- "Add a request" on a conflict card lets you say how to settle it in your
  own words. The model drafts a plan from the request, you can refine the
  request or apply the plan, and the result can be undone.
- Conflicts between a memory and AGENTS.md / CLAUDE.md use the same card:
  the suggestion is to rewrite the memory, delete it, or keep both. The
  instruction file is never changed. Suggestions for these conflicts are
  made and applied from a session in the project the conflict was found in.
- The sidebar shows the suggestion on a conflict, with Adopt and a link to
  settle it on the memory page.
- Suggestions cost extra model calls: one per new conflict after a
  checkup. Automatic checkups prepare at most 10 per run, the rest get
  "Suggest" on the card; memories with high-risk secrets are never sent.

### Changed
- The model gets a fuller picture of each memory type. When saving, it
  sees what each type holds, how to write it and an example, next to when
  to save it; a custom type's `description` is now part of this too. The
  memory snapshot ends with how to use each type it brought in. Memories
  are written as statements that name whose requirement or fact they are,
  so a remembered preference reads as background, not as an instruction.
- The built-in types reach beyond work: `profile` covers habits and family
  circumstances, `project` covers ongoing personal matters, `knowledge`
  keeps any confirmed fact that will matter again, and `reference` can
  point to where things are kept or whom to ask.
- In a subagent session, `memory_source` only traces memories whose source
  is that session. For memories a subagent still owns, it reads back from
  the save point instead of forward from the start of the turn: a
  subagent's task is often a single turn, and reading forward only showed
  the instruction it was given.
- `memory_source` output now includes tool results for every memory, so the
  evidence shows what the agent read, not only the messages around it.
- Earlier plugin versions read a memory written by a subagent as an
  ordinary one and keep its `delegation` field when they write the file
  back; after upgrading again it is pending as before.
- `host:contract` now also checks subagent writes on a real child session:
  saving, search order, `memory_source` and acceptance by the parent.
  Without a model key it also runs `/memory` commands through DeepSeek
  Harness's command service and decodes the results with the interface
  contract, checks that automatic checkups register a timer with it, and
  checks that every slot the interface uses is declared by the installed
  DeepSeek Harness.
- `memory_save` takes `validFrom` and `validTo` as local `YYYY-MM-DD HH:mm`,
  or just a date when no time was given, which then gets the time of saving.
  Models often got the old epoch milliseconds wrong, saving memories that had
  already expired. A deadline alone starts at the time of saving; an
  impossible date, a deadline that has passed, or one before `validFrom` is
  rejected with a reason so the model can correct it. `memory_health` shows
  expired dates in the same format.
- Memory files show `validFrom` and `validTo` in local time as
  `YYYY-MM-DD HH:mm`, the same form `memory_save` takes, so you can read and
  edit them directly. Existing files are converted at the next write or
  session start; a value that was not on a whole minute is rounded outward
  (start down, end up), so no memory expires earlier than before. A date
  alone takes the hour and minute of the file's modification time. Versions
  before 0.2.0 cannot read files with these keys in the new form.
- Saving a memory no longer turns into the reply: the model answers what
  you said instead of announcing "noted" or quoting memory ids, since the
  chat card already shows what was saved. It still acknowledges briefly
  when you explicitly ask it to remember something.
- The memory snapshot is now a message of its own instead of a section of
  the host's shared runtime context; the trajectory view lists it as a
  separate context row from plastic-memory. A change in another plugin's
  context section no longer sends a second copy of the snapshot along with
  it, and minimal mode, which drops the runtime context, now brings
  memories in as well.
- The memory snapshot now opens with a short note addressed to the host's
  compaction engine: the entries below it are reinjected after every
  compaction, so the checkpoint should leave their content out and only keep
  what the conversation did with memories (saved, deleted, promoted,
  confirmed). Before, a compaction summary could copy memory entries into
  the checkpoint, where they stayed as a second, stale copy. The closing
  note for the model now also says that where a compaction summary and the
  snapshot disagree about a memory, the snapshot wins, and that a memory the
  summary mentions but the snapshot no longer lists has been deleted or
  rewritten.
- CI's package check now also requires `README.md` and `README.en.md` in
  the published package.
- Memory cards are easier to scan: the type is a tag, and scope, source
  and date each get an icon from DeepSeek Harness's icon set. The source
  icon tells apart you, the agent and the environment.
- Wherever you decide on a memory, a suggestion below it says why you are
  asked and what each choice does, always above the buttons. Once you
  decide, a result line takes its place, with undo where the decision can
  be undone. "Could become global" and "Rewritten" moved out of the
  memory's details into these lines.
  Conflict cards on the memory page and in the sidebar share one layout:
  the two memories, a note on what each choice does, then the three
  choices together in one row.
- Scenes replace the three fixed templates. A scene is the set of memory
  types the model can add, picked from a type pool: the five built-in types,
  the presets `procedure` and `decision`, and your custom types. General
  (`template: custom`) stays fixed to the five built-in types; Coding and
  Office can now be edited or removed, and you can create up to five scenes
  besides General, each with 1 to 8 types. Scenes are stored under the new
  `scenes` key, and `template` names the current one. Switching scenes only
  changes what can be added; existing memories of every type in the pool
  are still injected and searchable.
- Custom types no longer apply in every scene: they join the type pool and
  are used once ticked into a scene. After upgrading, the current scene stays
  the same and no config is migrated. If you used `template: custom`
  together with `customTypes`, your custom types can no longer be added,
  because General is fixed; create a scene on the settings page with the
  built-in types and your custom types, and switch to it.
- Office now adds only `decision`, which also covers commitments (who
  promised whom what, by when); the model often could not tell the two
  apart. `commitment` and `person` are retired: existing memories of these
  types are still read with their original names and decay periods, but no
  scene can add new ones. A custom type with one of these names is a new
  type, and the old memories are read with its definition.
- The settings page lists every type in the pool under Memory types,
  grouped as the base five, presets and your own, with the scenes that use
  it and how many memories it has. Custom types are created, edited and
  removed there or in the scene dialog, and their English name can now be
  changed. When a renamed or removed type
  already has memories, you choose whether they follow the new name or move
  to Recently deleted; removing a type can also keep its memories. The
  memories are moved after the settings are saved, with a retry if some
  could not be moved. Memories that contain secrets are not moved to
  Recently deleted and are counted separately.
- The settings page no longer shows the user dictionary path;
  `search.userDictionaryPath` in `cordis.patch.yml` still works. The
  per-type "Expires after (days)" field is now "Decay after (days)", since
  passing it only marks a memory as possibly outdated.
- The memory view groups a project's or the global memories by type, in
  the current scene's order, and shows the first three of each type with
  the rest one click away. All lists memories by when they last changed:
  the last 24 hours, 3 days, 7 days, and earlier (folded). Each card there
  names its scope, which opens that scope with the memory highlighted.
- Recently deleted is grouped by the day a memory was deleted: today, the
  last 7 days, and earlier. While the memory page stays open, it keeps
  which groups you folded and where you scrolled in each view and scope,
  and switching views no longer flashes a loading line.
- Automatic checkups refresh the memory page as soon as they finish and
  clear past decisions that can no longer be undone, the same as checkups
  you start yourself.
- When a ruling in the right sidebar deletes a memory, the result line adds
  that the chat keeps what it already loaded and the change applies after
  compaction or in the next chat.
- Conflict cards label the two sides with a plain A and B, and line icons
  keep a one-pixel stroke at every size, so small marks stay sharp.
- Overall polish of how the panels report an action: a failure reads the
  same in the chat card, the sidebar, To do, All and Recently deleted, next
  to the row it concerns, and an action on a memory being handled elsewhere
  says it did not take effect. Deleting a memory of another project from the
  chat card asks first. Hints, counts and paths in the edit, move and "Edit
  with model" panels use the secondary text color, and tool descriptions
  and results call global and project memory a scope.
- The ids in `memory_save`'s `supersedes` go through secret detection like
  the other fields, and the checkup's note about references to missing
  memories masks secrets.
- Actions taken on the memory page or in the sidebar show up in the chat as
  one gray line, such as "Memory · Delete a memory", instead of the raw
  command result. A failed action says it did not go through and why,
  without red text, since the panel already reported it in place. Clicking
  the line shows the command and its full result, with secrets masked.
- The `types` parameter of `memory_search` now describes the current
  scene's types, notes which ones are usually already in the memory
  snapshot, and is updated as soon as the scene or custom types change.
  When none of the requested types has a memory in scope, the result says
  so and lists the types that do, with counts, so the model can tell a
  wrong type from keywords that did not match.
- `memory_search` keeps a single search from flooding the context with
  long memories. The top hits still come with their full text, but a very
  long memory, and lower-ranked hits once enough full text has been
  returned, show only a passage of the text (around the matched keywords when
  there are any), marked as an
  excerpt with the memory's total length. The model gets the full text by
  searching for the memory's id or reading the file on the hit's first line.

### Fixed
- Checkup findings referred to memories by internal ids such as
  `mem_xxx`. Their descriptions now use the memory names.
- Two checkups running at the same time could list the same conflict twice
  under "Waiting on you". Ruling the two copies in opposite ways deleted
  both memories. A conflict is now listed once, copies left by an earlier
  version are folded into one at the next checkup, and a ruling that deletes
  a memory is turned down while another ruling on the same pair is in
  progress or once the memory to keep is no longer in use.
- Memory files edited outside the plugin (in an editor, by git or by a sync
  tool) did not show up on the Memory page until the plugin itself wrote a
  memory, and editing such a memory on the page failed with "refresh, then
  edit again" while nothing on the page could refresh it. The Memory page
  now reloads its lists from disk each time it opens. When an action is
  turned down because the memory changed or was deleted elsewhere, the page
  switches to what is on disk and says so. An edit or merge started before
  such a change is still checked against the version it started from, so it
  never overwrites the outside edit.
- The plugin page of DeepSeek Harness 0.2.2-rc.1 shows the README as the
  plugin's details; its banner and architecture diagram showed as broken
  images because the package did not ship them. Both now ship with it.
- Turning plastic-memory off and back on in the plugin page left its
  interface missing (the Memory entry in the left sidebar, the right sidebar
  tab, the composer button and the settings card) until the app restarted.
  The interface now comes back as soon as the plugin is turned on again.
- After a compaction on DeepSeek Harness 0.2.1-rc.2, the step that compacted
  injected the old snapshot again and the next step added the fresh one,
  leaving two snapshots in the conversation. The snapshot is now rebuilt in
  the compacting step itself, so the conversation carries exactly one, up to
  date, snapshot after each automatic or manual compaction. A compaction
  attempt that fails (for example because the summary would not be smaller
  than what it replaces) no longer triggers a snapshot refresh either, since
  nothing was removed and a refresh would only add a second copy next to
  the old one.
- Hard-deleting one copy of a memory that also exists in another scope
  (global and a project, or two projects) no longer clears the other copy's
  undo history, and no longer marks its snapshots as holding a secret, which
  made restoring that copy fail. When a memory is hard-deleted because of a
  secret, snapshots taken before it was promoted or moved are still redacted.
- Choosing "Keep both" on a conflict carried over from 0.1.x, before the
  first checkup after upgrading, is now remembered: the next checkup no
  longer reports the same pair, and Undo works. When a decision cannot be
  recorded, the result says the next checkup may report it again and offers
  no Undo.
- When the same memory exists in two projects, the saved-memories card in a
  chat promotes the copy it shows, not the other one.
- In chats started before the upgrade from a subfolder or a symlinked path,
  delete, promote and view on the saved-memories card find the memory again.
- Memories flagged only as a possible secret can be edited on the memory
  page and handed to the model for a rewrite again; only memories that
  clearly contain a secret stay read-only there. A merge whose removed memory holds
  a secret is refused before anything changes, instead of updating the kept
  memory first.
- After DeepSeek Harness restarts, the memory tab in the right sidebar says
  the chat still carries the memories brought in before the restart, instead
  of saying none had been brought in. When memories are sent again mid-chat
  because settings or memories changed, the tab and the composer button say
  so instead of "brought in at chat start".
- Changing a setting the memory snapshot doesn't use, such as checkup
  sensitivity or where promoted memories go, no longer refreshes the
  snapshot in every open chat. Only settings that shape it do: the scene and
  types, the token budget and overflow handling, and evidence lookup.
- Recently deleted rounds the remaining days up, so a memory deleted a
  moment ago shows 14 days left instead of 13.
- Private key blocks whose lines start or end with a no-break space or a
  full-width space, as text copied from web pages or typed with a Chinese
  input method often does, are masked whole. Before, only the BEGIN line
  was masked and the key body could show in snapshots and search results.
- When a question like "数据库连接池的密码是什么" matches a memory's topic
  but not the thing asked for, `memory_search` shows which keywords the top
  hit matched, so the model can see what it lacks. English articles,
  prepositions and auxiliaries such as "to" or "with" never count as
  missing.
- On a fresh install, the memory page updates after you delete a memory or
  handle a card even if it was opened before its data files existed.
  Before, it kept showing the old list until reloaded.
- With checkups turned off, the error now points to `governance.enabled` in
  the config file, and the note about ignored findings points to "Don't
  remind me" in the memory page's To do view, instead of places that no
  longer exist.
- `pnpm lint` (oxlint) joins CI and the contributor checklist. Besides the
  default correctness rules it keeps the pure logic free of runtime imports
  from the host packages, so it stays testable without a host.
- When the model rewrites a memory that you edited on the memory page, or
  that another chat changed, while it was working, the rewrite is rejected
  and the model gets the current content to start from; a memory you edited
  by hand still needs your consent first. A `supersedes` pointing at a
  memory that was deleted, rewritten or moved in the meantime leaves it as
  it is.
- An edit or merge on the memory page that meets a change made elsewhere at
  the same moment asks you to refresh and edit again, and keeps the other
  version and both memories as they are.
- Resolving a conflict deletes a losing memory that holds a high-risk secret
  permanently and erases it from every snapshot, like deleting it directly;
  the card says so beforehand and offers no undo afterwards. A loser holding
  only a suspected secret, confirmed when it was saved, still goes to
  Recently deleted.
- A snapshot taken while another chat permanently deletes one of its
  memories does not keep that memory in plain text, and a secret spanning
  two fields, such as a private key split between name and summary, is
  erased from both.
- Removing a type in settings leaves alone memories that were changed to
  another type while the removal ran.
- High-risk secrets edited by hand into a summary are masked in duplicate
  hints, promotion candidates, cross-project duplicate topics, what a
  cross-project checkup sends to the model, and `memory_source` output.
  "Edit with model" sends nothing that contains a high-risk secret.
- When `~/.dsh/AGENTS.md` cannot be read, promoting to it fails, keeps the
  memory and leaves the file untouched. When every file name a new memory
  could take is held by other files, the save fails without overwriting any
  of them.
- With the desktop app and `dsh web` open at the same time, a memory view
  collected earlier but written later does not replace a newer one, and the
  two keep each other's chat-to-project assignments. The memory page keeps
  updating after the system clock is set back.
- After upgrading from 0.1.x, deleting a memory permanently waits until the
  one-off import of old data has finished and says so, so a resumed import
  cannot bring plain-text copies back from old snapshots. A resumed import
  on a disk without hard links replaces the half-written files it left.
- Undo checks the exact copy a change touched: when that memory was edited,
  deleted or moved afterwards, every kind of undo says so and changes
  nothing, and the memory page's undo button agrees with it. Undoing a merge
  restores both memories or neither, and a memory just promoted to global or
  kept in its project can be undone while a checkup is running.
- Restoring from Recently deleted a memory that a conflict ruling removed
  works like undoing that ruling and says the conflict goes back to Waiting
  on you. A memory restored from a snapshot and edited right away keeps the
  edit.
- A renamed preset type shows the same name on the memory page, in the right
  sidebar and on pending cards, and the English interface shows English type
  names throughout. The relaxed budget shown in the overflow card and usage
  bars matches the one in effect.
- The memory page treats a project path with and without a trailing
  separator as one project, as the right sidebar does.
- Undoing a promotion to global, or a conflict ruling, changes nothing when
  the memory was deleted or changed in the meantime, or when no snapshot
  of it was kept; it no longer brings back a memory deleted after the
  promotion.
- A memory file or folder that cannot be read for a moment no longer
  leaves its snapshot copies permanently unrestorable.
- Cancelling a checkup after it has already recorded its results counts
  as done and refreshes the memory page. A failed automatic checkup no
  longer marks a scope as failed when a later checkup of it has already
  finished.
- The memory page picks up settings that finish loading after it opens, or
  that reload while the app runs, instead of staying on the defaults until
  it is reopened.
- With reduced motion turned on in the system, the checkup spinner stays
  still instead of turning slowly.

## [0.2.0-beta.1] - 2026-10-25

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
- A whale-tail icon for the plugin on the host's plugin page, in place of the
  generic placeholder.
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
- Chinese word segmentation for `memory_search`. The optional dependency
  `@node-rs/jieba` is installed with the plugin from npm and loaded the first
  time a query contains Chinese, once per host process, so a long Chinese
  question matches memories by word instead of by stray character pairs. If
  it cannot be installed or loaded on your platform, Chinese search falls
  back to two-character segments, a warning is logged once, and nothing else
  changes.
- A user dictionary for that segmentation: `search.userDictionaryPath`, also
  a field on the settings page, points to a file with one
  `word frequency tag` entry per line (for example `插件记忆 10 n`). Its words
  are added on top of the built-in dictionary from the next search on. The
  path must be absolute and the frequency is required; a missing or
  malformed file leaves search on the built-in dictionary and is reported
  once in the log.
- Each `memory_search` hit carries the absolute path of its memory file,
  shown at the end of the hit's first line, so the model can read the full
  file or its surroundings directly.
- When a `memory_search` query matches more memories than it returns, the
  result opens with the total and the number shown. The model can then ask
  for more with a larger `limit`, up to 50, or narrow the query with more
  specific keywords.
- An evaluation set of 86 synthetic memories and 48 queries (short and long
  Chinese, identifiers, partial words, plain names, ids) runs with the tests
  and fails when top-1 or top-3 accuracy drops below a fixed floor, with and
  without the Chinese segmenter.
  It also holds queries written in the other language from the memory, with
  and without that spelling among its tags, long questions with and without
  an answer, and short queries with no answer in the corpus; the tests fail
  when a query with no answer, or one in the other language that the memory
  has no tag for, is not flagged as a weak match, or when more than five
  other queries with a correct top hit are.
- The checkup buttons on the memory page and the settings status card carry a
  line saying the checkup uses the current chat's model and that more
  memories take more tokens. When a checkup finishes, its result line ends
  with the tokens it actually used, summed from what the host reports for
  every model call; nothing is shown when the host reports no usage.
- When the model marks a new memory as fitting every project, the card under
  that turn and the sidebar's 「这次新写入的」 offer 「提升为全局」 and
  「留在本项目」 in place, with 「撤销」 next to the outcome, and show the
  outcome wherever it was decided. When the promotion target is AGENTS.md,
  the button reads 「写进 AGENTS.md」 and works as it does in 「等你决定」.
  This adds nothing to the pending list and does not light the nav dot;
  candidates left alone still reach 「等你决定」 at the next checkup.
- When the model rewrites or replaces an existing memory, the turn's card and
  the sidebar's 「这次新写入的」 list show it, with the text before and after,
  and offer 「撤销修改」 for 14 days. Undo is refused once the memory has been
  changed again since.

### Changed
- Memories that exceed `snapshotTokenBudget` are no longer cut from the
  injected index by default. The new setting `snapshotOverflow` defaults to
  `relax`: everything is still injected, the budget is relaxed in 25 % steps
  and each step is reported once on the memory page, with a shortcut to raise
  the limit or dismiss. Set it to `strict` to keep the previous behaviour, in
  which the index lines stop at the budget; the page then says how many
  memories were left out.
- Token usage is now estimated per character, calibrated against DeepSeek's
  tokenizer: each Chinese, Japanese or Korean character or full-width
  punctuation mark counts as 0.6 tokens, any other character 0.3. The same
  4,000 default now fits about 6,700 Chinese characters, up from about 2,700.
  English text is counted per character too, so English-heavy memories now
  estimate higher and may cross the limit. Existing overflow reminders are
  recomputed the next time memories are loaded.
- The content check of a checkup now checks every memory in batches of about
  30,000 estimated tokens, keeping memories of one type together, instead of
  only the first 200, so a large library no longer exceeds what a single model
  call can take. When a layer needs more than one batch the result says so,
  because a conflict or duplicate between memories in different batches can
  be missed.
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
- Requires DeepSeek Harness v0.2.1-rc.2 or later, the first version whose
  plugin interface slots the GUI uses. Older hosts refuse to install or start
  this release; stay on 0.1.1-beta.5 there.
- Memories are now plain files and nothing else. The Markdown files on disk
  are the only copy: the plugin keeps no table in memory, loads nothing at
  start-up, and reads just the directories an operation needs. A file you
  create, edit or delete by hand, with git or from another process shows up in
  the next tool call and the next session's prompt without a restart. On a
  library of 10 projects × 1000 memories (Apple M4), start-up dropped from
  1.5 s to 0 and the 109 ms fingerprint check before every tool call is gone;
  `memory_save` takes 190–280 ms, a single-layer `memory_health` 135 ms and a
  whole-library one 1.1 s. `pnpm bench:storage` reproduces these numbers on
  your machine.
- Storage layout: `global/` and one `<project>-<hash>/` directory per
  workspace (marked by a `.workspace` file holding the project path). A memory
  file is named after its `name`; `MEMORY.md` in each directory is a generated
  index of the memories currently in effect; `.archive/` holds forgotten and
  superseded memories for 14 days; `.state/` holds the plugin's own snapshots,
  pending decisions, scan cache and recall statistics. Existing files are read
  in place; snapshots and pending decisions are imported from the host's KV
  store on first use (or at a later start if the store is not available yet),
  by one host process at a time so a decision you settle right after the
  upgrade does not come back, and the imported copies there are removed once
  the import has finished (retried at later starts if removal fails). Recall
  statistics and the scan cache are not imported and start fresh. The host's
  `storageDomain` service is therefore no longer required.
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
- `memory_search` ranks results by relevance. Memories containing every
  query word come before those containing only some of them, a word that
  appears as a whole word ranks above one that only appears inside a longer
  word (`scope` in `readScope`), and matches in the name, summary and tags
  weigh more than matches in the content; a query that is exactly a memory
  id returns that memory first, without a note. The result opens with a note
  when no returned memory contains every keyword (`or-fallback`), and adds
  how many memories each keyword matched when the top hit lacks a whole
  keyword. Coverage counts two Chinese characters as one word, so a
  mixed-language query is judged the same whichever language the top hit is
  written in. It flags a weak match only when the top hit covers less than
  half of the query's content (`low-coverage`) or when nothing but a literal match
  on the query text is left (`substring-fallback`), and then suggests
  searching again, for example with the term in the other language.
  Question words and particles in long questions don't count. The notes are
  signals for the model, not verdicts: a missing word often just means the
  memory phrases it differently, so whether to search again is left to the
  model.
- The `memory_search` tool description now says what the tool does: it ranks
  by relevance, accepts Chinese and English queries and returns file paths.
  It explains how queries are matched (keywords separated by spaces, Chinese
  and English spellings matched separately) and what the result notes mean,
  and leaves the rest to the model: it can search from several angles, use
  the user's words or related wording it judges useful, and decide
  how many searches a question needs. `memory_save` asks for synonyms,
  bilingual aliases and abbreviations in tags, limited to words the name, summary and content
  don't already contain, so later searches phrased differently still find
  the memory.
- `memory_save` now asks the model to note, next to the rule itself, the
  reason the user gave or the situation it came up in, so a later session can
  tell where the rule applies, and to leave out details that go stale
  quickly, such as line numbers; the summary no longer stacks keywords, and
  each `sourceMode` value is explained. The checkup now reports a bare
  one-line conclusion whose scope cannot be told as unclear. Existing
  memories are not rewritten.
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
  duplicate ids (the newest copy wins, a deleted copy never hides one still
  in use, and the others stay until you remove them), workspace directories
  without a `.workspace` marker, unreadable or empty directories.
- `pnpm host:contract` now also checks that a file written straight into the
  memory directory is injected into the next session (H15) and that the
  host's grep tool finds top-level memories but nothing under `.archive/`
  (H16). `pnpm host:smoke` boots the real host with a probe plugin that
  confirms the tools are registered.
- `pnpm host:smoke` runs twice, once with the package as published and once
  with its optional dependencies removed; both must load and register
  `memory_search`. `pnpm host:contract` also checks that every search hit
  carries an absolute path to an existing file.
- `pnpm bench:storage` reports search latency, the share of files that pass
  the pre-read text filter, and the heap used while scoring, for a typical
  query and a common-word query under both segmenters. Each row passes when
  search is at most 80 ms slower than a reference measured in the same run
  and scoring holds less than 2 MB.
- The model no longer rewrites or replaces a memory you edited by hand,
  whether in its file or on the memory page, without asking first:
  `memory_save` returns the current text and waits for your go-ahead before
  overwriting.

### Fixed
- A memory holding a vendor-format key (such as `sk-`, `ghp_`, an AWS
  access key or a PEM private key), for example typed into a memory file by
  hand, was injected into every conversation as is. The injected text now
  shows `[已隐藏]` in place of just the key (for a private key, the whole
  block up to its `END` line) and leaves the rest of the memory as it was,
  with no extra notice in the conversation; if the key is in a memory's
  name, its index line leaves out the file path. `memory_search` results,
  which still give the file path, and the text a checkup sends to the model
  hide the key the same way. `memory_forget` still removes the file for
  good.
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
- Promoting a memory that contains a secret to `AGENTS.md` copied the secret
  there in plain text, where every session in every project reads it and
  forgetting the memory cannot remove it. Such memories are now refused with
  a message saying why and stay in the project unchanged. Promoting to global
  memory is unaffected.
- Promoting a project memory to global overwrote the global memory with the
  same id, if there was one. Such promotions are now refused with a message
  saying why, and both memories stay as they were.
- A key quoted in the reason given to `memory_forget`, in a `memory_snapshot`
  description or in a checkup's conflict summary was logged and saved as is,
  so it stayed in the host log, the snapshots and the pending list even after
  the memory itself was deleted for good. Such keys are now replaced with
  `[已隐藏]` before the text is logged or saved.
- A memory file that fails to parse is reported with the parser's error,
  which quotes the offending line, so a key on that line showed up as is in
  `memory_scan` results. Keys and suspected secrets in that error are now
  replaced with `[已隐藏]` wherever it is shown, the memory page included.

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
