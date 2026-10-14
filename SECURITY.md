# Security

## What wdym touches

- **Reads:** the prompt your agent passes to the hook, and (to judge a card answer) the
  transcript file path the agent hands the hook. Nothing else.
- **Writes:** `~/.jtl/wdym/` only (config, `reads.jsonl`, state), created with owner-only
  permissions. `wire.mjs apply` also links the skill and adds one hook entry to Claude Code's
  `settings.json` and Codex's `hooks.json`; `wire.mjs remove` takes both out, and `plan` shows
  every change before it is made.
- **Network:** none. No telemetry, no install script, no dependencies.
- **Failure:** the hook never blocks a prompt. On any error, or past the 5 s timeout
  `wire.mjs` sets, your prompt runs as if wdym were not installed.

## Reporting a problem

Open a private report through GitHub's "Report a vulnerability" button on this repository.
Please do not open a public issue for a security problem.
