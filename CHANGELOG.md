# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `memory_search` keyword results and type listings page with `offset`, as
  topic browsing does: the result gives the next page's offset instead of
  suggesting a larger `limit`, and `limit` takes a positive integer up to 50.
  Past conversations are not paged; when both are searched, later pages list
  memories only.
- When DeepSeek Harness's tool-result pruning threshold leaves `memory_search`
  less than 6,000 characters per search, `memory_health` lists the threshold
  and suggests raising `thresholdChars` of
  `@deepseek-ai/dsh-compaction-tool-result-pruner` to at least 6,316. It does
  not affect the score.
- Testing: `pnpm host:contract` checks that search output stays within the
  pruning threshold on the default setting, at the 3,000-character floor and
  with the pruner off, and that a long memory looked up by id comes back in
  full.
- Experimental: when the assistant saves a memory as a state change or a
  correction, active decisions that list it under `related` are added to the
  To do tab on the Memory page for review; the decisions themselves are not
  changed. Turn it on under Checkups on the settings page, or set
  `governance.relatedRecheck` in the config file; it works while governance
  is on (off by default). Turning it off clears the unresolved
  entries at the next checkup.
- `memory_confirm` with `action: accept-subagent` takes `memoryIds` to accept a
  subagent's whole batch of pending memories in one call. The result groups
  them by the topic of the closest existing memory, marks near-duplicates
  within a group and overlaps with existing memories, and lists any it could
  not accept with the reason, while the rest are still accepted. Grouping is
  only for review: accepted memories go to the unsorted page until the topic
  index is organized.
- Testing: `pnpm host:contract` accepts a real subagent's batch through
  `memoryIds` and checks the grouped result and the files.
- `memory_save` can record when a fact happened or held true, preserving the
  precision and time zone supplied by the user.
- `memory_search` can show a memory's past versions: give its `id` with
  `history: true` to list them, newest first, with when each ended and why it
  changed, or with `version` to read one in full, secrets masked as in other
  results. Search results say how many past versions a memory has, when it has
  any. `query` is no longer required; a search gives `query`, `types` or `id`,
  and a combination that does not fit says which parameters conflict. When
  some past versions cannot be read, the list says so and shows the ones it
  could read.
- `memory_search` can search past conversations in the current project, including
  content never saved as a memory, and return quoted messages with nearby context.
  Each message includes a reference for `memory_source` to expand it with the
  preceding and following turns (up to 8,000 characters for the selected message,
  with a truncation note for longer messages). It searches memories and past
  conversations together by default; choose Search in on the settings page,
  or set `search.source` in the config file to `memory` to search memories
  only, or to `dialogue` for conversations only.
- The top three memories in a `memory_search` result carry the exchange they
  were saved from: your message and the assistant's reply, quoted from the
  local copy of past conversations, up to about 1,000 tokens per search. When
  the exchange cannot be shown, for example because the conversation was
  deleted or marked as not to be reviewed, the result says so. It is on by
  default; turn off Attach source quotes to results on the settings page, or
  set `search.memoryQuotes` to `false` in the config file. While it is on, the guidance loaded into each chat tells the assistant to read these quotes
  first and to open the conversation with `memory_source` only when they are
  not enough. Whenever results can include quoted messages, from conversation
  search or from these quotes, the guidance also says when to expand an excerpt
  by its reference.
- When `memory_search` covers both memories and past conversations, each
  exchange appears only once. An exchange quoted under a memory is left out of
  the conversation results, and other parts of it that match the search are
  added under that memory. A conversation turn that a listed memory was saved
  from, but that is not quoted under it, ranks higher and names that memory.
  Conversation results keep their own limit of about 1,500 tokens
  (`search.dialogueTokenBudget`), separate from the quotes under memories.
  Other quotes per search on the settings page sets it in passages of about
  300 tokens, from 2 to 10.
- Searching past conversations finds an identifier however it is written:
  `getUserName`, `get_user_name` and `GetUserName` find each other,
  and `user name` finds `getUserName`.
- The assistant can search past conversations up to three times in a row.
  From the fourth search on, conversations are not searched again and the
  result says the limit is reached; a search that also covers memories still
  returns them. The count starts over when a new turn begins or the assistant
  uses a tool other than `memory_search` and `memory_source`.
- Groundwork for Brewing Dreams, an experimental background pass that tidies
  memories while no chat is running. It is off and has no switch yet. Once on
  for a scope (all memories, or one project), a pass starts only when enough
  has changed since the last one and the project folders it covers are idle,
  and it stops at the next step when a chat starts. The start conditions are
  in the config file under `brewingDreams`.
- A Brewing Dreams pass now tidies the memories that changed since the last
  pass: it files unsorted memories into topics and organizes the topic index,
  refreshes summaries and tags, links related memories and adjusts how each
  memory is injected, though never to core, the level that injects the full
  text into every chat.
  Locked memories are left alone, and a change is skipped when the memory was
  edited after the model read it. One pass changes at most a share of the
  scope's active memories (`brewingDreams.maxChangeRatio`, 20% by default);
  what is left over is picked up by the next pass. Filing
  memories into topics and reorganizing topics change only the topic index,
  so they do not count toward that share. The changes of a pass can
  be undone together or one at a time, also while governance is turned off.
- A Brewing Dreams pass also merges memories in the same scope that repeat
  each other or each hold part of the same thing: one memory is rewritten
  into the combined text, and the others move to Recently deleted and point
  to it, with their earlier versions listed in its history. A merge is
  skipped as a whole when one of the memories is locked, contains something
  that looks like a secret, or was edited after the model read it, and when
  the combined text would be longer than 2,000 characters. Undoing a merge
  restores every memory in it, and later passes do not propose the same
  merge again unless the type, name or text of one of those memories changes.
- A Brewing Dreams pass also settles conflicts and missed changes that
  checkups found between two memories of the same scope: after reading the
  conversations both were saved from, it makes the older memory an earlier
  version of the newer one, or corrects it. It acts only when your own words
  or a tool result from outside the memory folder back the change and the
  newer memory's fact time shows it came later; pairs with a locked memory,
  something that looks like a secret, or anything less clear are left for
  you to decide. With `brewingDreams.tier` at `gatekeep`, the default, a change
  to a memory you stated yourself whose type is in `brewingDreams.focusTypes`
  (`preference`, `profile` and `decision` by default) waits for you, and
  `memory_confirm` can adopt it; with `trust`, such changes are applied too.
  Before settling conflicts, each pass runs an incremental checkup of its
  scope, so new conflicts are found and settled in the same pass even with
  automatic checkups off;
  memories that have not changed are not sent to the model again. Sources in
  archived conversations count too, and a pass reads the sources of at most
  20 pairs, starting after the pair where the previous pass stopped.
- Experimental: when a Brewing Dreams pass refreshes summaries and adjusts
  how each memory is injected, it also sees how the memory has been used:
  how often it was recalled, in how many chats it was read in full by its id,
  how often it was confirmed as still accurate, and how often it was
  corrected within 24 hours of being recalled. These counts only guide the
  model and nothing is ranked by them. They are recorded without a setting
  and kept on this machine outside the memory folder, with no memory text.
- A Brewing Dreams pass can also go back to the conversations a memory came
  from to fill gaps such as the reason for a change, a decision's basis or
  the options it ruled out, or a past state between two versions more than
  180 days apart. When every message it relies on is your own words, the pass
  refines the memory or adds the past state to its history; otherwise the
  draft is kept in the pass's report and nothing is written. A pass reads at
  most `brewingDreams.maxDrillDowns` places in past conversations (5 by
  default, 0 turns this off), and what it writes is undone with the pass.
- The plugin records which project folders have a chat running in
  `.state/activity/` inside the memory folder, so several DeepSeek Harness
  windows that share a memory folder can tell when a project is idle. A
  window running an older version of the plugin is not seen by the others.
- The plugin can keep a searchable local copy of past conversations, built
  from the conversation logs of DeepSeek Harness, for the projects that have
  memories and the project of the current chat. Conversation search and source
  quotes are on by default, so after updating the copy is built in the
  background and caught up before each search. It holds the full text of what
  you and the assistant said, plus short or failed tool results, and stays on
  this machine outside the memory folder, in
  `~/.dsh/plastic-memory/<id>/dialogue-records.sqlite` (under `DSH_HOME` when
  that is set). The settings page shows its status under How to manage ›
  Storage. To stop keeping it, set Search in to Memories only and turn off
  Attach source quotes to results (`search.source: memory`,
  `search.memoryQuotes: false`), then delete it there or run
  `/memory delete-dialogue-records`; while either is on, a deleted copy is
  rebuilt from the logs. After a save that leaves it unused, the settings
  page asks whether to delete it; it is never deleted without confirmation.
- After an update, `memory_save` lists numbers, dates, names and paths that
  are no longer in the memory, and points out a refinement that removed a
  large part of the text. It also suggests combining memories when a single
  turn creates a third one, and splitting a memory whose text is longer than
  2,000 characters.
- `memory_source` lists all sources of a memory and lets you select one, page
  backward or forward, search its conversation, include tool calls and results,
  and trace a sub-agent memory to its parent or child conversation. Results
  include the conversation title, start time and event counts.
- Each memory folder now has a topic index under `_index/`. `index.md`
  lists the topics, each with a short description, and every page in
  `_index/topics/` lists the memories of one topic. Existing memories start
  on the 未整理 (unsorted) page. You can edit these files by hand: change a
  description, reorder lines, move a memory to another page. Your edits are
  kept. When a chat next loads its memories, memories missing from the
  index are added to the unsorted page, lines for memories that no longer
  exist are removed, and names and summaries are brought up to date.
- The topic index of a memory folder can be organized in one pass. The model
  of the current chat proposes changes: move memories into topics, split,
  rename or merge topics, reorder them, rewrite a description. Each change
  is checked against the files as they are at that moment and skipped if it
  no longer fits; memories themselves are not changed. A renamed or merged
  topic keeps its old name as a former name, so a chat that still has the
  old name finds it. One pass can be undone as a whole, and lines added
  to a topic afterwards stay. A folder holds at most 30 topics by default
  (`index.maxTopics` in the config file).
- `memory_save` can link memories. `related` points a memory at others about
  connected matters, for example a decision and the project status it
  changes; `premises` records which memories a decision is based on, along
  with what they said at the time, so a later change to a premise can be
  noticed. Links are appended and never removed by a later save, with up to
  10 of each per memory. A memory in a project can point at memories in the
  same project and global memories; a global memory only at global ones. To
  add links to an existing memory, an update can carry just the id and the
  links: its text and modification time stay as they are. When a memory is
  promoted to global or moved from global into a project, links it can no
  longer reach are dropped and listed in the result; undoing the promotion
  or the move brings them back, except those that are still out of reach.
- A memory that a decision cites as a premise always keeps its old version
  when its state changes, even within the window where quick successive
  edits are otherwise combined into one version, so the version the decision
  was based on stays available.
- Each memory type's confirmation period can now be changed, the five
  general types included: every type card on the settings page shows its
  period, and Edit opens the form where you change it. A memory left
  unconfirmed for longer shows up as not confirmed in a while, so the
  reminder can follow how quickly each kind of information goes out of date.
- Checkups can use a model of your choice: the settings page lists
  the models available in DeepSeek Harness by provider, with reasoning effort
  where the model offers it, and the choice applies right away in every
  window, to automatic checkups and to Check now on the memory page alike.
  Without a choice, both use the default model. If the chosen model becomes
  unavailable, the checkup runs on the default model and says so in its
  result. If the saved choice cannot be read, the settings page and the
  automatic checkup menu say so instead of showing the default model, a
  failed automatic checkup gives that reason, and choosing again fixes it.
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
- A change to a memory that is cut short, for example when the app quits
  partway, is finished the next time a memory is written: the record that
  lets you undo a model rewrite is added, and the old file of a memory that
  was being moved is removed. Each memory file now carries a `lastWriteOp`
  line naming the write that last touched it; undoing a change updates it
  too. The log this uses is kept outside the memory folder, one per machine,
  and holds no memory text.
- Testing: each kind of memory write is stopped before every disk call and
  checked after the next write.
- When the model updates a memory it now says what kind of change it is
  (`change`): the same thing came up again, a detail was added, a mistake
  was corrected, or the situation changed. When the situation changed, the
  memory as it was is kept as a history version under `.history/` next to
  the memory file, with when it stopped being current and why; undoing the
  update removes that version again. Several such changes to one memory
  from the same conversation within an hour keep one version
  (`history.mergeWindowMinutes`).
- A memory's history versions follow it: deleting it for good (including
  when it held a secret, or when its 14 days in Recently deleted run out)
  deletes them too, and promoting it or moving it to a project takes them
  along. History versions of memories that were already deleted, promoted or
  moved are moved to where the memory now is, or removed if it no longer
  exists, the next time a chat loads its memories.
- Each memory file lists the conversations it came from (`sourceTrail`, the
  eight most recent), and `lastChange` records the last change to its
  content, with the reason when one was given.
- Testing: `pnpm host:contract` checks on a real host that an update without
  `change` is sent back with the memory's current content, and that the
  earlier content is kept under `.history/` when it is written.
- Memories saved while nobody was at the keyboard are labelled. When a
  scheduled run or another agent opens the turn, a memory written in it
  carries the note `（无人值守时写入）` ("written while unattended") wherever it
  is injected later, and its source entry records who opened the turn and
  whether a message from you or a tool result backs it.
- Testing: `pnpm host:contract` also checks how many events a forked session
  inherits and that a save in a turn opened by a schedule is rejected.
- Testing: every regular expression used to detect secrets is checked by
  static analysis for backtracking that grows faster than the input, and the
  private key block cases run under a time limit, so a regression fails the
  test instead of hanging the run.
- Checkups now keep each batch's result and send a batch to the model again
  only when the content of one of its memories, the checkup model or the
  instruction files changed; adding evidence to a memory without changing
  its content does not resend it. A checkup stops at a token cap
  (`governance.scan.tokenCap`, 200,000 by default) and the next one
  continues where it stopped.
- Checkup results say how much of each scope was covered: memories never
  checked, changed since their last check, or waiting to be rechecked, and
  whether some memories could not be read. A scope is reported healthy only
  when every memory in it has a current result and the instruction files
  could be read in full; a scope with memories that was never checked counts
  as not fully checked.
- A project's coverage includes the global memories. Each project's checkup
  checks them together with the project's own memories, so that conflicts
  between the two are found, and keeps those results per project: a global
  memory can be current in one project and still waiting in another.
- A Recheck all action next to the checkup button sends every memory to the
  model again, including those whose result is still current, after asking
  for confirmation.
- Testing: seeded random sequences run capped checkups between saves, edits,
  deletions and conflict decisions, and check that every finding shown comes
  from a current result or a still-valid earlier one, and that a final full
  checkup finds the same as one started from an empty cache.
- Testing: the model-backed checks in `pnpm host:contract` can run on another
  provider route DeepSeek Harness ships with, set with `TEST_LLM_PROVIDER`,
  `TEST_LLM_MODEL` and `TEST_LLM_API_KEY`. Setting only some of them stops the
  run, and checks that only apply to the official provider are reported as
  skipped.
- In a long chat, when another chat, the memory page or a background task
  changes a memory this chat has already loaded, the assistant gets a short
  notice before its next step: changed memories with their current name and
  summary, and one line for each that was deleted, replaced or moved. Changes
  made by the chat itself and edits made by hand to memory files are not
  announced. A memory that comes back after a deletion or move notice is
  announced again with its current name and summary.
- The notice does not resend the loaded memories. After a compaction or a
  settings change the memories are loaded again as before, and earlier
  changes are not announced.
- Testing: `pnpm host:contract` checks that a change made in another chat
  reaches the next step of a running chat as one notice ahead of the user's
  message, and is not repeated on the step after.
- `memory_search` can browse a topic: give `topic` with its name or a
  former name to list its memories in index order, with name, summary, tags
  and file path, the total and the `offset` of the next page; `未整理` lists
  the memories not yet in a topic. Add `query` to search within the topic.
  The memories loaded into a chat now point to `topic`.
- When a topic index exists, keyword results name the topic each memory
  belongs to and how many other memories it holds. When the keywords match a
  topic's name or description, the result names that topic first; when nothing
  or little matches, it ends with the current list of topics.
- When a scope's topic index cannot be read, a search by topic says so
  instead of reporting that the topic does not exist. Index lines that point
  to memories that cannot be read are skipped and counted.
- Testing: `pnpm host:contract` checks that DeepSeek Harness sees `topic` and
  `offset` as optional parameters of `memory_search`. The scale check also
  reports how long listing a topic and searching within it take at 5,000
  memories, without a pass/fail threshold.
- Checkups now tell apart three cases that used to be reported as conflicts:
  a narrower exception to a general rule, a change that was never recorded as
  a new version, and a real conflict. A missed change comes with a plan to
  merge the two memories into versions of one, with the one the checkup judges
  current kept as the current version; applying it can be undone. When a
  later checkup judges a pending pair differently, its entry changes kind
  instead of a second one being added.
- Before a conflict between two memories is reported, the checkup reads the
  conversations each one was saved from and judges the pair again, up to five
  pairs per checkup. A conflict whose sources cannot be read is still reported
  and says so.
- Checkups report when a memory that another memory lists as a premise has
  changed, without a model call. Duplicates across projects now name the
  memories in each project and can come with a plan to promote one to global.
- `memory_confirm` can resolve a pair as not a conflict or as an exception.
  The pair is not reported again as a conflict, exception or missed change
  until the content of either memory changes.
- The memory page has a card for each new kind. Merge as versions asks which
  memory is current, with the suggested one selected; a changed premise links
  to the decision to review; a cross-project duplicate offers to promote one
  to global. On conflict cards, Keep both is replaced by Not a conflict and
  Mark as exception, and conflicts between two memories also offer Merge as
  versions. Each result can be undone.
- When the exchange quoted under a memory has little in common with the
  memory, `memory_search` checks the five turns before it. If one matches the
  memory clearly better, that turn is quoted too, marked as a guessed source;
  otherwise the quote notes that the memory may come from earlier turns.
  A memory saved with the whole conversation as its source, rather than one
  exchange, can likewise get the closest of the last 20 turns before it was
  saved, marked as guessed, instead of only a note that the exchange cannot be
  found.
- `memory_save` takes a `topic`, plus a one-line `topicAbout` when the topic
  is new, and lists the memory first on that topic's page in the topic index;
  names match regardless of case and surrounding spaces, former names
  included. A new topic's result names the two closest existing topics, and a
  name that cannot be used or a full topic list still saves the memory to the
  unsorted page, with the reason in the result.
- An `update` with `topic` moves the memory to that topic. An `update` that
  passes only `topic` leaves the memory file untouched and can be undone.
- The topic index follows a memory as soon as it changes: a new name, summary
  or file name updates its line, and deleting, restoring, promoting or moving
  it to a project updates the indexes involved. A memory restored from
  Recently deleted goes to the unsorted page; one a subagent saves joins a
  topic only after it is accepted.
- A new memory saved under an existing topic is also checked for duplicates
  against the other memories in that topic.
- Testing: `pnpm host:contract` checks that DeepSeek Harness sees `topic` and
  `topicAbout` as optional parameters of `memory_save`.
- When a search of past conversations finds nothing or only partial matches,
  `memory_search` asks the current chat's model for other words the earlier
  conversation may have used (synonyms, another language, names from code),
  searches again with them and merges the results, keeping the first search's
  best turns on top. The model sees the search words, your message in the
  current turn, up to three excerpts from the first search and the names and
  tags of up to five related memories; if it fails or takes more than about
  10 seconds, you get the first search's result with a note. It is on by
  default; turn it off on the settings page or set `search.queryExpansion`
  to `false` in the config file. The settings page can also pick another
  model for it; without a choice it uses the chat's model.
- When `memory_search` searches past conversations only, it also looks for
  matching memories and moves the turns they were saved from up the results.
- Each memory on the memory page has a Details button. It shows the memory's
  card and its past versions, newest first: when each applied, why it changed,
  when the fact held and the session it came from. Versions merged in from
  another memory name that memory. Clicking a version shows its name and
  content, and Back to list returns to the row it was opened from.
- Details also draw a memory's direct links as a graph: memories it points to
  on the left, memories that point to it on the right, and conflicts waiting
  for you as dashed lines. Clicking a neighbour makes it the centre, a
  neighbour in another scope opens in that scope, and a conflict opens in
  To do. Replaced, deleted and unreadable neighbours are marked, and the
  graph says when links may be incomplete.

### Changed
- The settings page is organized into four tabs: What to remember, How
  to use, How to manage and Appearance. One Save button covers all tabs;
  a tab with unsaved changes shows a dot and the save row names those
  tabs. The chat-start limit is now called Limit (tokens) and the source
  check When to check.
- `memory_search` output stays under DeepSeek Harness's tool-result pruning
  threshold (95% of it, at least 3,000 characters), so a long result is no
  longer cut in the middle once the context fills up. When a result does not
  fit, excerpts from other conversations and optional notes go first, then
  later memories become excerpts or header lines and the rest moves to the
  next page; the result says what was left out and how to get it back.
- A memory looked up by its id in `query` comes back in full even when it was
  already loaded at the start of the chat or is longer than the output limit;
  the result says when it goes over the limit.
- Testing: `pnpm host:contract` runs the default-model automatic checkup
  without a model key, using a fixed successful HTTP stream through the real
  host adapter and scheduler. It checks the request route and saved findings,
  and reports each checkup stage, the last saved state and read errors on
  failure.
- `memory_save` now guides the assistant to keep one topic, state or event
  per memory and to update the same memory when a project or decision
  changes, so the earlier state stays as a past version. Decisions are
  written with their reasons, rejected options and premises and linked to the
  memory that tracks their project; when something to remember contradicts
  `AGENTS.md` or `CLAUDE.md`, the assistant tells you on the spot. A decision
  type you have edited keeps your wording until you restore the preset.
- Testing: `pnpm bench:dialogue` measures the past-conversation index at scale
  on synthetic logs, and CI's scale-bench job runs a small tier of it that
  checks catch-up before a search stays within its time limit and two
  processes indexing at once end up with the same index. Unit tests check the
  same time limit by counting log reads, and that a full disk is reported as
  past conversations being unavailable while memory search works as usual.
- The local copy of past conversations is built faster for very long
  conversations: the background no longer rereads the whole conversation log
  each time it continues. Catch-up before a search now takes turns among open
  conversations, so with many chats open they are all caught up over a few
  searches instead of the same first few every time.
- Testing: `pnpm host:contract` checks how model errors are reported by
  answering requests to the model API with fixed responses instead of using
  a real invalid key, so the check also runs without a model key. A 401 must
  come out as an authentication error with the response text kept out of
  scan results and the checkup view; a 550 must count as a server error,
  unless its body says it is an authentication error.
- The memories loaded at the start of a chat now follow the topic index.
  After the memories given in full, each topic gets one line with its
  description, how many memories it holds and how many have not been
  confirmed for a while, followed by up to five of its memories in index
  order. Project topics come first, then global ones, and each scope ends
  with its unsorted memories, whose count is always shown.
- The topic list and memory lines loaded into a chat stay within about
  2,000 tokens in both overflow modes, so they no longer grow with the
  number of memories; the memories given in full keep following the
  existing budget settings. When space runs out, memory lines of later
  topics go first, then topic descriptions, then whole topics, noted as
  "N more topics".
- A memory's own injection setting now applies: `core` loads it in full,
  `unlisted` keeps it out of the list while it still counts toward its topic
  and stays searchable. If a scope's topic index cannot be read, that scope
  lists its memories without topics and says so. A type's priority no
  longer orders the loaded memories; it orders the content checkup, and the
  memories of a scope listed without topics.
- Testing: the scale check also asserts that the topic list and memory lines
  stay within their token cap at 1,000 and 5,000 memories.
- Refining a memory, recording a state change and other single-memory
  edits no longer reread every memory in the project to check their
  snapshot, so these writes slow down much less as a project grows.
- Testing: a separate CI check compares write medians for 1,000 and 5,000
  memories in one project, with version history and links, within the same
  run. It asserts refine, corroborate and state-change writes and only
  reports creates; it does not block merging, since timing on shared
  runners is noisy.
- Memories whose effective time is still in the future no longer enter conversations
  or search results, and are not reported as expired.
- Merging two memories now records which memory the removed one went into.
  The removed memory keeps its earlier versions while it is in recently
  deleted; when it is deleted for good, they move under the memory that was
  kept and stay marked as coming from the removed one. Restoring the removed
  memory, or undoing the merge, brings both back as they were.
- `memory_save` now refuses a new memory only when it is almost word for
  word the same as an existing one (ignoring spaces and punctuation); the
  reply names that memory and the three ways forward. Other new memories
  are saved, and the reply lists up to five similar ones so the model can
  update one of them instead.
- `force` on `memory_save` now only skips the near-duplicate check. Saving
  something that looks like a secret after you confirm it is not one uses
  a new parameter, `allowSecret`; sub-agents can use neither. The memory
  page's "Save anyway" sends `allowSecret` as well.
- `memory_source` omits tool results by default; pass `include: "all"` to read them.
- `MEMORY.md` is now generated from the topic index: one section per topic
  with its description and the number of memories in it, linking to the
  topic page. It no longer lists every memory on one page, and it is
  refreshed when a chat loads its memories instead of on every write. A
  `MEMORY.md` written by an earlier version of the plugin is regenerated
  the same way.
- Node.js 24.9 or later is now required; Node.js 22 is no longer supported.
  Every supported DeepSeek Harness version already requires 24.9, so a
  working install is not affected. CI no longer runs on Node.js 22.
- A save made while another session changes the same memory is applied to
  the memory as it is at that moment, so a recall setting, validity period,
  related memory or lock changed elsewhere in the meantime is kept. A
  precise edit is retried once on the latest text and the result shows the
  merged text; a full rewrite still goes through, with the version it
  replaced kept for undo. If the memory was deleted, promoted or moved in
  the meantime, the save is refused so the model reads it again.
- The recall options of a memory type are renamed after what each chat
  carries: Always, Search and Passive are now Full text, Summary and Brief
  index (全文, 摘要 and 简单索引 in Chinese). The settings page, the side
  panel and the guide use the new names; the values in configuration
  (`core`, `search`, `passive`) stay the same.
- Each change to a memory (its snapshot, the memory file and the record
  that lets you undo it) now runs as one step under the memory folder's
  write lock. If the lock stays busy, the change fails as a whole and can
  be retried, instead of stopping partway.
- A model update to a memory's text no longer counts as confirming it,
  unless the user stated the new content or the update records that the
  situation changed. Noting that the same thing came up again does count.
  The "not confirmed in a while" reminder follows this, and so do the
  places that order memories by when they were last confirmed.
- Saving or changing a memory no longer reads every file in the memory
  folder, so a write no longer slows down as the folder grows. Files edited
  by hand are picked up, deleted memories are archived and expired ones are
  removed when a chat in that project next loads its memories, instead of
  after every write. To
  find a memory by id the plugin keeps a small lookup file outside the
  memory folder, one per machine. It holds memory file names (which come
  from memory names) and ids, no memory content; a permanently deleted
  memory is removed from it at once, and it is rebuilt from the memory
  files if it is deleted.
- Testing: a write in a folder of 5,000 memories is compared with the same
  write in a folder of 1,000.
- `memory_save` no longer accepts "the user said so" in a turn you did not
  open, so a scheduled run or another agent cannot record a memory as
  something you said. In a turn opened by a scheduled run, another agent or a
  subagent's task, `sourceMode` must be `environment-observed` or
  `agent-inferred`; other values are rejected with `not-user-initiated`.
- Applying a Tidy selected plan, or a merge or rewrite proposed for a
  conflict, now changes the memories one at a time, each with its own undo
  snapshot, and records the edit in `lastChange`. If one of them was edited
  in the meantime, the ones already changed are put back, as before. Undo
  puts back only the fields the change wrote: a recall setting or links
  changed elsewhere since then are kept. If an undo stops partway, what was
  already undone stays undone and undoing again finishes the rest.
- When the instruction files change, the next checkups recheck the whole
  scope against them, even if no memory changed.
- A small memory library is checked as a single batch: a checkup with no
  memory changed sends nothing to the model, and a change to any one memory
  rechecks the whole batch.
- Expired memories are no longer sent to the content check. The rule check
  still points them out.
- When a checkup looks at a project, the content check now names that project
  and says the instruction files it is compared against belong to it, so the
  model knows which project those files describe. Earlier results are checked
  again once after the update.

### Fixed
- In the chat, the collapsed `memory_search` row showed an empty search when
  the assistant listed memories by type. It now says which types were listed
  and how many memories came back.
- A memory you moved into the `.archive/` folder by hand while its file still
  said it was in use came back into use when it was accepted or rewritten,
  and restoring it from Recently deleted left it in `.archive/`. Both now
  treat it as deleted, as reads already did.
- Accepting a subagent's memory that was moved to another scope after it was
  looked up accepted the moved copy. It is now reported as missing and the
  moved copy is left alone.
- Permanently deleting a memory left its name and summary in the topic index
  and `MEMORY.md` when another memory file in the same folder could not be
  read. Its line is now removed; lines for the unreadable files stay.
- A memory write that was cut short and whose file was then edited by hand
  or removed was treated as never written, so the record that lets you undo
  it was not added. It is now added the next time a memory is written.
- Restoring a snapshot over a memory edited since (`overwriteChanged`) left
  the memory dated as of the snapshot, earlier than the version it replaced.
  `lastChange` now records the restore.
- `memory_source` showed context that DeepSeek Harness adds to a conversation
  as if you had typed it, and left out what the assistant replied. It now
  shows assistant replies and leaves the added context out.
- A deleted memory whose 14 days in Recently deleted had run out could
  still be restored until the next cleanup removed it. Restoring it is now
  refused.
- When the record of interrupted writes was briefly in use by another
  window at startup, it was replaced with an empty one, so a write cut off
  by a crash was not finished afterwards. It is now left in place and
  opened again on the next write.
- A memory file whose timestamp was a number outside the range of a date was
  read as normal, and the next change to that memory failed. Such files now go
  to quarantine, like other malformed files.
- A memory folder that could not be read, for example after a permission
  change, was treated as empty: the chat went without those memories for
  the rest of the session, `MEMORY.md` was rewritten without them and
  dismissed over-budget reminders came back. The chat is now told the
  memories could not be read, nothing is rewritten, and the next message
  reads the folder again.
- If a memory folder could not be listed during routine upkeep, a memory in
  it that also had a deleted copy could be looked up as the deleted copy
  until the folder changed. The folder now keeps what was known about it.
- If a memory folder could not be listed during routine upkeep while its
  archive and topic index still could, upkeep cleared the recall counts of a
  memory that had an expired deleted copy, and rewrote `MEMORY.md` without
  its count of memories not confirmed in a while. Upkeep now leaves the
  archive, recall counts, topic index and `MEMORY.md` alone until every
  folder involved can be listed.
- The note after the memories loaded into a chat said that a memory named in
  a compacted summary but missing from the list had been deleted or
  rewritten, though the list can leave memories out. The note now says the
  list is partial, and asks the chat to look such a memory up first and to
  treat it as unconfirmed if nothing is found.
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
- Actions on the memory page, in the side panel and on chat cards that cannot
  run because the session is open in another window, the session is busy or
  the connection was interrupted now say so in the interface language,
  instead of showing an error code.
- A suggestion for a conflict was discarded as unreadable when the model's
  reply had braces in the text around its answer. It is now read as long as
  the reply holds exactly one answer.
- Text that repeated a password label such as `password:` or the start of a
  JWT many times in one long unbroken string could take seconds to check
  for secrets, and the app stopped responding meanwhile. Such text is now
  checked as quickly as any other text of the same length.
- Hiding secrets in a memory that held tens of thousands of secret-like
  values took time that grew with the square of their number. It now grows
  in step with the length of the text.
- When the model updated a memory that another memory had already replaced,
  the change was reported as saved but went to a memory that is no longer
  used and could not be undone. `memory_save` now refuses it and tells the
  model which memory replaced it, so the update goes there instead.
- When the list in the side panel refreshed while deleting a new memory or
  undoing that delete, the row could vanish and keyboard focus jumped to
  another control or was lost. The row now stays in place until the action
  finishes, also when it was the only memory, and focus stays on that row.
- After a delete in the side panel failed, or the confirmation for a memory
  with a secret was cancelled, deleting that memory elsewhere made the side
  panel show it as deleted there, sometimes with the warning meant for
  secrets. It is now simply removed, like other memories deleted elsewhere.
- A conflict suggestion, or a plan written from your request, could come back
  as not generated when the model chose to merge or rewrite but left out the
  new text, and you had to ask for it again. The model is now asked once more
  on its own to include the text.
- A conflict you kept or dismissed was not reported again when only the fact
  time or validity of one of its memories changed.
- A checkup of all memories left out a project whose memory folder could not
  be listed, and cleared earlier results as if everything had been read. The
  project now stays in the checkup and is reported as not fully read.
- `memory_health` for all memories failed as a whole when one project could
  not be read, and left out a project that held only files it could not
  parse, so their problems went unreported. It now lists the same projects
  as a checkup of all memories, counts unparseable files against their
  project, and marks a project it could not read in full instead of scoring
  it as healthy.
- `memory_health` presented how many memories the last checkup covered as if
  it had checked them just now. It now says the figures come from the last
  checkup.
- Deleting a memory from a page that had not yet caught up with a promotion
  or a move made elsewhere said the memory might have been deleted elsewhere,
  although a copy of it still existed in another scope. It now says the
  memory was just changed or moved elsewhere and deletes nothing.
- A memory whose summary spanned several lines, for example with a line
  starting with `###`, added what looked like extra headings to the memory
  list loaded into a chat. A memory's name, summary and tags are now kept on
  its one line there, and angle brackets in them no longer read as tags.
- After Undo on a deleted memory in a chat's saved-memories card, the card
  showed the memory and its delete button again before the restore had
  finished. The card now stays deleted, with Undo shown as busy, until the
  memory is back.
- An unexpected error during an automatic checkup, or while applying a change
  to the plugin's settings, closed DeepSeek Harness. The error is now written
  to the log, and an automatic checkup that hit it counts as failed and is
  retried like other failed checkups.
- A conflict you resolved while a checkup was running could come back as
  pending when that checkup finished, because it recorded what it had read
  before your change and treated your verdict as out of date. A checkup now
  reads the memories again before recording a finding, along with the
  `AGENTS.md` or `CLAUDE.md` a memory conflicts with, and drops the finding if
  any of them changed since it first read them.

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
