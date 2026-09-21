# tallyhook collector

One dependency-free Node.js file that reads the session logs **Claude Code** and **Codex CLI** already write on your machine and works out what they cost.

## See what each repo cost you (no account, nothing uploaded)

```sh
npx tallyhook report
```

```
AI coding-agent usage on this machine, last 30 days (public API list prices)

REPO                              SESSIONS    OUTPUT    LIST COST
github.com/acme/storefront             118     10.8M    $1,450.59
github.com/acme/patient-portal         100      7.2M      $867.84
local:scratch                            4     96.2k       $20.36
TOTAL                                  222     18.1M    $2,338.79

Previous 30 days: $1,602.11 across 186 sessions — up 46%.

Most expensive session: $84.10 in github.com/acme/storefront, started 2026-09-14.
```

`report` runs entirely on your machine. Its only network call is a GET for the public price table (`https://tallyhook.dev/api/prices`). Prefer to read it first? It is one file, `tallyhook.js`, in this repo. Download it, read it, then run `node tallyhook.js report`.

| flag | what it does |
| --- | --- |
| `--days 90` | a longer window. The trend line always compares against the equally long window immediately before it, so `--days 7` compares this week against last week. |
| `--by model` | group by model instead of by repo. A session that spanned two models has its cost split between them rather than attributed whole. |
| `--json` | the same numbers with no prose, for a script. Nothing that could not be priced is guessed: if the price table is unreachable, every cost is `null` and `priced` is `false`. |

## What it gets right

- **Streamed rows:** Claude Code writes one JSONL row per content block, each carrying the same `usage` object. Rows are deduplicated by `message.id`.
- **Subagents:** forked subagent transcripts copy the parent's assistant rows. Deduplication spans every file of a session.
- **Cache pricing:** cache reads, 5-minute cache writes (1.25x input) and 1-hour cache writes (2x input) are priced separately. Fast-mode messages are priced at the fast-mode rate.
- **Codex:** reads `~/.codex/sessions/**/*.jsonl`, and the `.jsonl.zst` files Codex compresses after seven days (needs Node 22.15+; older Node skips them).
- **Repos, not folders:** sessions are grouped by git remote (`host/org/repo`), so the same repo in two checkouts is one line. No remote means `local:<folder>`.
- **Honest numbers:** costs are list-price equivalents from the vendors' public API pricing. On a subscription that is the value of what you used, not a bill. A model with no known price is reported as unpriced rather than guessed.

## Ask your agent what it just cost you

```sh
npx tallyhook mcp
```

An [MCP](https://modelcontextprotocol.io) server over stdio, so Claude Code (or any MCP client) can
answer cost questions about its own work. **No account, no token, nothing uploaded** — it reads the
same local logs `report` does.

Add it to Claude Code:

```sh
claude mcp add tallyhook -- npx -y tallyhook mcp
```

Or by hand, in `.mcp.json` or any MCP client's config:

```json
{ "mcpServers": { "tallyhook": { "command": "npx", "args": ["-y", "tallyhook", "mcp"] } } }
```

Then ask it things like *"what has this repo cost me this month?"*, *"which sessions were the
expensive ones?"* or *"am I spending more than last month?"*

| tool | answers |
| --- | --- |
| `usage_by_repo` | spend grouped by git repository over the last N days |
| `usage_by_model` | the same spend grouped by model — a session spanning two models is split between them, so the totals agree |
| `expensive_sessions` | the individual sessions that cost the most, for finding a runaway agent loop |
| `usage_summary` | total and session count, against the equally long window immediately before |

Parsing every local log is the slow part, so it is cached for a minute per process: the first
question takes a few seconds on a busy machine, the rest are instant. If you set
`"privacy": true` in `~/.tallyhook/config.json`, `expensive_sessions` omits the prompt snippet too.

## Team use: cost per client, budgets and invoices

[Tallyhook](https://tallyhook.dev) is the hosted team layer on top of this file: every developer's sessions in one place, repos mapped to clients, a monthly budget per client, an alert when one session gets expensive, and an invoice with your markup. There is a [live demo](https://tallyhook.dev/demo) that needs no signup.

```sh
npx tallyhook install <token>       # registers Claude Code hooks (SessionEnd, and Stop at most every 10 minutes), uploads history
npx tallyhook sync [--dry-run]      # upload anything new now; --dry-run prints a summary and never touches the network
npx tallyhook status                # what is configured
npx tallyhook uninstall             # remove the hooks and ~/.tallyhook
```

The MCP server above stays local and account-free either way; installing a token does not change
what it reads or send anything extra.

**Uploaded per session (install/sync only):** token counts by model, start and end time, tool and version, git remote and branch, developer identity from git config, machine hostname, turn and tool-call counts, paths of edited files, and the first 160 characters of the first prompt (turn that off with `"privacy": true` in `~/.tallyhook/config.json`).

**Never uploaded:** transcripts, code, diffs, tool output, environment variables.

Requirements: Node.js 18+, macOS or Linux. Licence: MIT.
