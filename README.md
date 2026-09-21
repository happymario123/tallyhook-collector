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

## Team use: cost per client, budgets and invoices

[Tallyhook](https://tallyhook.dev) is the hosted team layer on top of this file: every developer's sessions in one place, repos mapped to clients, a monthly budget per client, an alert when one session gets expensive, and an invoice with your markup. There is a [live demo](https://tallyhook.dev/demo) that needs no signup.

```sh
npx tallyhook install <token>       # registers Claude Code hooks (SessionEnd, and Stop at most every 10 minutes), uploads history
npx tallyhook sync [--dry-run]      # upload anything new now; --dry-run prints a summary and never touches the network
npx tallyhook status                # what is configured
npx tallyhook uninstall             # remove the hooks and ~/.tallyhook
```

**Uploaded per session (install/sync only):** token counts by model, start and end time, tool and version, git remote and branch, developer identity from git config, machine hostname, turn and tool-call counts, paths of edited files, and the first 160 characters of the first prompt (turn that off with `"privacy": true` in `~/.tallyhook/config.json`).

**Never uploaded:** transcripts, code, diffs, tool output, environment variables.

Requirements: Node.js 18+, macOS or Linux. Licence: MIT.
