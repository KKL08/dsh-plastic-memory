# Contributing

Thanks for helping. This page covers everything needed to go from a clone to a
pull request. The user-facing documentation is in [README.md](README.md).

> The plugin is in beta: interfaces, stored formats and the tool contract
> may still change between pre-releases.

## Setup

Requirements: Node `^22.19.0 || >=24`, [pnpm](https://pnpm.io) (the version is
pinned in `package.json` → `packageManager`; `corepack enable` picks it up).

```bash
git clone https://github.com/KKL08/dsh-plastic-memory.git
cd dsh-plastic-memory
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
```

`pnpm build` compiles `src/` to `lib/` (git-ignored; that is what npm ships).
Dev dependencies, including the `@deepseek-ai/*` host packages, come from npm at
the exact versions the plugin is built against — no checkout of the host is
needed.

## Layout

| Path | What it is |
|---|---|
| `src/` | The plugin. Each tool is a pure-logic module `src/tools/<x>.ts` plus a thin binding `src/tools/<x>-tool.ts` that calls the host's `defineTool`. Keep that split. |
| `src/contract-codes.ts` | The single list of machine-readable codes that tool results carry. Add a code here first, then use it. |
| `tests/` | vitest unit and integration tests (`tests/helpers/` has shared fixtures). |
| `scripts/host-smoke.sh` | Installs the packed plugin into a fresh, pinned dsh host and checks it loads. |
| `scripts/host-contract/` | Boots that host with a verify plugin that drives the nine tools through the real tool registry. |
| `scripts/use-host.cjs` | Points the host dev dependencies at another dsh version (default: the peer floor) for the floor CI job or a trial run. |
| `docs/` | Design notes referenced from source comments (`docs/*.md`). Not published yet; the contracts they describe are pinned by the tests and by `src/contract-codes.ts`. |

## Tests

Three layers, cheapest first. Run the first two on every change; the third
before a release or when touching anything that talks to the host.

1. **Unit and integration** — `pnpm test` (add `--coverage` for a report under
   `coverage/`). Tests assert behavior through structured fields and codes, not
   through Chinese prose; one `it` checks one thing; fixtures come from
   `tests/helpers/`; nothing under `~/.dsh` is touched. `tests/bindings.spec.ts`
   builds the tools with the real `defineTool` and checks every result against
   the host's lossless-JSON rule — keep it green when you change a result shape.
2. **Install smoke** — `pnpm host:smoke`. Builds and packs the published shape,
   installs the pinned dsh host into `~/.cache/dsh-plastic-memory` (once; later
   runs take seconds), installs the tarball into a temporary `DSH_HOME`, checks
   the config layer, boots the host until the plugin starts, and checks the
   installed `lib/` statically. No API key.
3. **Host contract** — `pnpm host:contract`. Same fresh host plus a sibling
   verify plugin; nine checks need no key (tool registration, no-cwd rejection,
   fresh-library health advice, file layout, lossless outputs, rule scan,
   snapshot round trip, promote dismissal, dangling evidence anchor). Set `DEEPSEEK_API_KEY` to also run the
   two semantic-layer checks; the key is written only into the temporary
   `DSH_HOME` and never anywhere else.

Set `HOST_SMOKE_KEEP=1` to keep the temporary directory (logs, `DSH_HOME`) of
either host check for debugging.

Before opening a PR: write the failing test first when fixing a bug, list the
edge cases when adding behavior, and run `scripts/check-no-local-paths.sh` — it
rejects machine-local paths and hostnames in tracked files.

## Host version

The plugin supports a range of DeepSeek Harness versions, not just the newest.

- **Pin.** The `@deepseek-ai/*` dev dependencies pin the version the plugin is
  built against (`0.2.1-rc.2` today); local checks and the `check` CI job run
  on it.
- **Floor.** The four `@deepseek-ai/dsh-*` peer dependencies declare the oldest
  supported host (`>=0.1.7-rc.1`), with no upper bound. Hosts from 0.1.7 on
  check these ranges when a plugin is installed and started; like pnpm, they
  compare with pre-releases included, so `0.2.1-alpha.1` satisfies the range.
  `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` stay `*` because the
  host only checks `dsh-*` peers. The `host-floor` CI job rewrites the dev
  dependencies to the floor with `node scripts/use-host.cjs` and runs the same
  checks there.

Moving the pin to a new host is routine: bump the dev dependencies (take
cordis and schemastery from `npm view @deepseek-ai/dsh@<version> dependencies`),
run all three test layers, and keep the floor where it is. Raise the floor only
when the plugin has to use a host API the floor lacks, or a host release breaks
compatibility so one build cannot serve both; say so in the changelog. To try a
host without editing by hand, run `node scripts/use-host.cjs <version>` and
`pnpm install --no-frozen-lockfile`, then revert `package.json` and
`pnpm-lock.yaml`.

## Commits and pull requests

- Conventional Commits: `type(scope): imperative summary` (≤ 50 characters, no
  period), a body wrapped at 72 columns that says what and why.
- One concern per PR; keep the diff surgical and match the surrounding style.
- Update `CHANGELOG.md` under *Unreleased* for anything a user would notice.
