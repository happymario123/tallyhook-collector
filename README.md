# npx tallyhook

What your AI coding agents actually cost — **per repo, and per client you bill.**

One dependency-free Node.js file. It reads the session logs **Claude Code** and **Codex CLI** already
write on your machine and prices them. No account, no signup, nothing uploaded.

```sh
npx tallyhook
```

```
AI coding-agent usage on this machine, last 30 days (public API list prices)

REPO                              SESSIONS    OUTPUT    LIST COST
github.com/acme/storefront             118     10.8M    $1,450.59
github.com/acme/patient-portal         100      7.2M      $867.84
github.com/globex/intranet              44      3.1M      $402.17
local:scratch                            4     96.2k       $20.36
TOTAL                                  266     21.2M    $2,740.96

Previous 30 days: $1,602.11 across 186 sessions — up 71%.
```

## The part no other local tool does: what to invoice

If you run agents on work you bill someone for, the number you need is not "what did this repo
cost" — it's "what do I put on Acme's invoice this month." So group the repos and set a rate:

```sh
npx tallyhook clients add "Acme Corp" acme/storefront acme/patient-portal --rate 20
npx tallyhook clients add "Globex" globex/ --rate 35
npx tallyhook --by client
```

```
CLIENT          SESSIONS    OUTPUT    LIST COST     BILLABLE
Acme Corp            218     18.0M    $2,318.43    $2,782.12
Globex                44      3.1M      $402.17      $542.93
TOTAL                262     21.1M    $2,720.60    $3,325.05

Not counted: $20.36 in repos no client claims. `tallyhook clients` lists them.
```

That mapping lives in `~/.tallyhook/clients.json`, on your machine, and it is still free and still
uploads nothing. `tallyhook clients` on its own prints the map **plus every repo no client claims
yet, most expensive first** — which is the list of work standing between you and a complete invoice.

Billable totals are summed from rows rounded to the cent, deliberately: a client who adds up the
lines you showed them has to land on the total you billed.

## Commands

```sh
npx tallyhook                       # spend per repo, last 30 days
npx tallyhook --by client           # roll repos up into the clients you bill
npx tallyhook --by model            # the same spend per model
npx tallyhook clients               # the billing map, and which repos nobody claims
npx tallyhook mcp                   # MCP server, so an agent can ask what its own work cost
```

| flag | what it does |
| --- | --- |
| `--days 90` | a longer window. The trend line always compares against the equally long window immediately before it, so `--days 7` compares this week against last week. |
| `--by client\|model\|repo` | how to group. A session that spanned two models has its cost split between them rather than attributed whole. |
| `--markup 20` | try a rate without saving it. Beats any stored rate for that one run, so it never silently no-ops. |
| `--json` | the same numbers with no prose, for a script. Nothing unpriceable is guessed: if the price table is unreachable every cost is `null` and `priced` is `false`. |

Everything above runs entirely on your machine. The only network call is a `GET` for the public price
table (`https://tallyhook.dev/api/prices`). Prefer to read it before you run it? It is one file,
`tallyhook.js`, in this repo — download it, read it, then `node tallyhook.js`.

## What it gets right

Most of the work in this file is in not being wrong:

- **Streamed rows:** Claude Code writes one JSONL row per content block, each carrying the same
  `usage` object. Rows are deduplicated by `message.id`, or the same tokens get counted many times.
- **Subagents:** forked subagent transcripts copy the parent's assistant rows. Deduplication spans
  every file of a session, including `subagents/*.jsonl`.
- **Cache pricing:** cache reads, 5-minute cache writes (1.25× input) and 1-hour cache writes
  (2× input) are each priced separately. Fast-mode messages are priced at the fast-mode rate.
- **Codex:** reads `~/.codex/sessions/**/*.jsonl`, and the `.jsonl.zst` files Codex compresses after
  seven days (needs Node 22.15+; older Node skips them rather than guessing).
- **Repos, not folders:** sessions group by git remote (`host/org/repo`), so the same repo in two
  checkouts is one line. No remote means `local:<folder>`.
- **Files, not just cwd:** a session that edited files in three repos is attributed to the repos the
  files belong to, not to whichever directory the agent happened to start in.
- **Honest numbers:** costs are list-price equivalents from the vendors' public API pricing. On a
  subscription that is the value of what you used, not a bill. A model with no known price is
  reported as unpriced rather than guessed at.

## Ask your agent what it just cost you

```sh
claude mcp add tallyhook -- npx -y tallyhook mcp
```

An [MCP](https://modelcontextprotocol.io) server over stdio, so Claude Code (or any MCP client) can
answer cost questions about its own work. **No account, no token, nothing uploaded** — it reads the
same local logs the report does. Or by hand, in `.mcp.json`:

```json
{ "mcpServers": { "tallyhook": { "command": "npx", "args": ["-y", "tallyhook", "mcp"] } } }
```

Then ask it *"what has this repo cost me this month?"*, *"which sessions were the expensive ones?"*
or *"am I spending more than last month?"*

| tool | answers |
| --- | --- |
| `usage_by_repo` | spend grouped by git repository over the last N days |
| `usage_by_model` | the same spend grouped by model — a session spanning two models is split between them, so the totals agree |
| `expensive_sessions` | the individual sessions that cost the most, for finding a runaway agent loop |
| `usage_summary` | total and session count, against the equally long window immediately before |

Parsing every local log is the slow part, so it is cached for a minute per process: the first
question takes a few seconds on a busy machine, the rest are instant. Set `"privacy": true` in
`~/.tallyhook/config.json` and `expensive_sessions` omits the prompt snippet too.

## When one machine is not enough

Everything above reads only what is on this disk, which is also its limit: it cannot see your
colleagues' sessions, it forgets history once Claude Code rotates its logs, and it cannot hand a
client anything. [Tallyhook](https://tallyhook.dev) is the hosted layer for those three:
every developer's sessions in one total, history that outlives the logs, a budget and alert per
client, and a report link you can send a client with no login. There is a
[live demo](https://tallyhook.dev/demo) that needs no signup.

```sh
npx tallyhook install <token>       # registers Claude Code hooks (SessionEnd, and Stop at most every 10 min), uploads history
npx tallyhook sync [--dry-run]      # upload anything new now; --dry-run prints a summary and never touches the network
npx tallyhook status                # what is configured
npx tallyhook uninstall             # remove the hooks and ~/.tallyhook
```

The local commands stay local and account-free either way; installing a token does not change what
they read or send anything extra.

**Uploaded per session (install/sync only):** token counts by model, start and end time, tool and
version, git remote and branch, which repositories the edited files belong to, developer identity
from git config, machine hostname, turn and tool-call counts, paths of edited files, and the first
160 characters of the first prompt (turn that off with `"privacy": true`).

**Never uploaded:** transcripts, code, diffs, tool output, environment variables.

---

Node.js 18+. macOS and Linux; Windows is newly allowed as of 0.4.2 and not yet verified. Licence: MIT.
