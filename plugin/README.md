# Tallyhook

What your AI coding agents cost, inside the agent itself.

This plugin adds two commands and one MCP server to Claude Code. All three read the Claude Code and
Codex session logs that already exist on your machine, price them against published list rates, and
report what each repository and each client you bill has cost. There is no account and no sign-up.

## What it adds

- `/tallyhook:cost` — what agent usage has cost, grouped by repository, by model, or by the clients
  you bill. Takes a day count, so `/tallyhook:cost 7` reports the last week.
- `/tallyhook:clients` — map repositories to the clients you invoice, apply a markup, and see which
  repositories no client claims yet.
- An MCP server exposing `usage_by_repo`, `usage_by_model`, `expensive_sessions` and `usage_summary`,
  so Claude can answer cost questions about its own work.

## What it runs and what it sends

Everything is run by the `tallyhook` npm package, pinned to an exact version. That package is one
dependency-free Node.js file, MIT licensed, and its source is at
https://github.com/tallyhook/tallyhook-collector.

It reads two directories: `~/.claude/projects` and `~/.codex/sessions`. It makes exactly one network
request, a `GET` to `https://tallyhook.dev/api/prices` for the public per-model price table, and it
sends nothing in that request beyond a user-agent. No transcripts, code, diffs, tool output, prompts
or environment variables leave the machine. If the price table cannot be reached, the commands report
token counts and say the prices were unavailable rather than estimating a figure.

Any client-to-repository mapping you create is written to `~/.tallyhook/clients.json` on your own
machine and is not uploaded.

## Costs are list-price equivalents

Figures are what the same tokens would cost at the providers' public API rates. On a Pro, Max or Team
subscription that is the value of what was used, not a bill you received.

## Optional hosted companion

[Tallyhook](https://tallyhook.dev) is a hosted service for teams that need history beyond local log
retention, several developers in one total, or a report link to send a client. The commands and MCP
server in this plugin work fully without it and never require an account.

## Licence

MIT.
