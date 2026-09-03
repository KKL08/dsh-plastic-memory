# Security

## Reporting

If you find a vulnerability in dsh-plastic-memory, please open a private
security advisory on GitHub (Security → Report a vulnerability) or contact the
maintainer through the repository. Please do not file public issues for
unpatched vulnerabilities.

## What the plugin does with secrets

Memories are plain markdown files under `$DSH_HOME/memories`. Before anything is
written the save pipeline scans content, name, summary and tags for credential
patterns: entries with clear vendor signatures (`sk-…`, `ghp_…`, `AKIA…`, PEM
blocks, Slack/Google tokens, bearer tokens) are rejected and never reach disk;
suspected passwords or generic API keys are saved with a warning that asks the
user to rewrite them as a pointer. The scan and health tools flag anything that
slipped through. The plugin never reads `~/.dsh/.credentials.yaml` and never
sends memory content anywhere except to the LLM the host is already configured
to use, and only during an explicit semantic scan.

The test fixtures under `tests/` contain deliberately fake credentials marked
`TESTONLY` so that secret scanners can tell them apart from real leaks.
