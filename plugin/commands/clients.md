---
description: Map repos to the clients you bill, and see what is still unmapped
argument-hint: "[client name] [repo...]"
allowed-tools: Bash
---

Help the user map repositories to the clients they bill, so agent spend can be invoiced.

First show the current state, which also lists every repo no client claims yet:

```sh
npx -y tallyhook@0.5.0 clients
```

If `$ARGUMENTS` names a client and one or more repo patterns, add it:

```sh
npx -y tallyhook@0.5.0 clients add "<client name>" <pattern>... --rate <percent>
```

Notes that matter:

- A pattern is matched case-insensitively as a **substring** of the repo string the collector
  records (`github.com/acme/web`, or `local:<folder>` when there is no git remote). A `*` makes it
  an anchored glob instead. So `acme` catches every Acme repo; `acme/web*` is narrower.
- `--rate` is the markup percentage added on top of cost to get the billable figure. Leave it out and
  the client falls back to the file-wide default from `tallyhook clients markup N`.
- The mapping is stored in `~/.tallyhook/clients.json` on this machine. Nothing is uploaded.
- **Do not invent a markup.** If the user hasn't said what they charge, ask, or add the client with
  no rate so billable equals cost.

After adding, the command reports how many sessions and how much spend the new pattern actually
matched. If it matched nothing, the pattern is wrong — show the unmapped repo list again and suggest
one that appears in it rather than guessing twice.

Then offer `npx -y tallyhook@0.5.0 --by client` to show the billable table.
