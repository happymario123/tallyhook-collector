---
description: What AI agent usage has cost, per repo or per client you bill
argument-hint: "[days] [by client|model|repo]"
allowed-tools: Bash
---

Report what AI coding-agent usage has cost on this machine.

Run the local reporter. It reads the Claude Code and Codex logs already on this disk, needs no
account, and uploads nothing:

```sh
npx -y tallyhook@0.5.0 --json $ARGUMENTS
```

Interpret `$ARGUMENTS` loosely before you run it, and translate it into the real flags:

- a bare number means `--days N`
- "client", "per client", "billing" or "invoice" means `--by client`
- "model" means `--by model`
- nothing at all means the default: the last 30 days, grouped by repo

Then tell the user, in a few lines:

1. The total for the window, and whether it is up or down against the previous equally long window.
2. The two or three repos (or clients) that account for most of it.
3. Anything genuinely worth acting on — one repo dominating, a single runaway session, or most of the
   spend sitting on an expensive model where a cheaper one would plausibly do.

Two things to be careful about, because getting them wrong misleads the user about money:

- These are **list-price equivalents** from the vendors' public API pricing. On a Pro or Max
  subscription this is the value of what was used, **not a bill**. Say so if you quote a total.
- If `priced` is `false` the price table was unreachable and every cost is `null`. Report the token
  counts and say the prices were unavailable. Never estimate a dollar figure yourself.

If `--by client` reports that no clients are defined, don't fabricate a grouping — tell the user that
mapping repos to clients is what `/tallyhook:clients` does.
