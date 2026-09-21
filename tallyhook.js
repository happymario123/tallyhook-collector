#!/usr/bin/env node
/*
 * tallyhook collector — reads Claude Code and Codex CLI session logs on this
 * machine and uploads per-session METADATA to your Tallyhook workspace:
 * tokens by model, repo/branch, developer, turn and tool counts, files touched,
 * and the first prompt (160 chars, disable with `privacy: true`). Transcripts,
 * code and tool output never leave the machine. Zero dependencies, Node >= 18.
 *
 *   node tallyhook.js install <token> [--api https://tallyhook.dev]
 *   node tallyhook.js sync [--quiet] [--full] [--dry-run]
 *   node tallyhook.js status | uninstall
 *   node tallyhook.js report [--days 30] [--by model] [--json]   local only, nothing uploaded
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const VERSION = "0.2.0";
const FETCH_TIMEOUT_MS = 8000;
const HOME = os.homedir();
const DIR = path.join(HOME, ".tallyhook");
const CONFIG = path.join(DIR, "config.json");
const STATE = path.join(DIR, "state.json");
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
const CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json");
const CODEX_SESSIONS = path.join(HOME, ".codex", "sessions");
const STOP_SYNC_MIN_GAP_MS = 10 * 60 * 1000;

// Codex compresses rollouts older than seven days to .jsonl.zst. Node 22.15+ can read them natively;
// on older Node those files are skipped rather than half-parsed.
const CAN_ZSTD = typeof zlib.zstdDecompressSync === "function";
function readLog(file) {
  if (file.endsWith(".zst")) return zlib.zstdDecompressSync(fs.readFileSync(file)).toString("utf8");
  return fs.readFileSync(file, "utf8");
}
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } }
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tallyhook-tmp";
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p); // atomic replace: never leaves a half-written settings file
}
function readSettings() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return {};
  const text = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new Error(`${CLAUDE_SETTINGS} is not valid JSON; fix it before installing so nothing in it gets lost`); }
}
function log(quiet, ...a) { if (!quiet) console.log(...a); }

// ---------- git / identity helpers (cached per process) ----------
const remoteCache = new Map();
function repoForCwd(cwd) {
  if (!cwd) return null;
  if (remoteCache.has(cwd)) return remoteCache.get(cwd);
  let repo = null;
  try {
    if (fs.existsSync(cwd)) {
      const url = execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
      repo = normalizeRemote(url);
    }
  } catch { /* no remote */ }
  if (!repo) {
    try {
      if (fs.existsSync(cwd)) {
        const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
        if (top) repo = "local:" + path.basename(top);
      }
    } catch { /* not a git repo */ }
  }
  if (!repo) repo = "local:" + path.basename(cwd);
  remoteCache.set(cwd, repo);
  return repo;
}
function normalizeRemote(url) {
  if (!url) return null;
  let u = url.trim();
  u = u.replace(/^ssh:\/\//, "").replace(/^git@/, "").replace(/^https?:\/\//, "").replace(/^[^@\/]+@/, "");
  u = u.replace(/^([^:\/]+):(?!\d)/, "$1/"); // github.com:org/repo -> github.com/org/repo
  u = u.replace(/\.git$/, "").replace(/\/+$/, "");
  return u ? u.toLowerCase() : null;
}
let devIdentity = null;
function getDev(config) {
  if (devIdentity) return devIdentity;
  let email = config.devEmail || null, name = config.devName || null;
  try { if (!email) email = execFileSync("git", ["config", "--global", "user.email"], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim() || null; } catch { /* unset */ }
  try { if (!name) name = execFileSync("git", ["config", "--global", "user.name"], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim() || null; } catch { /* unset */ }
  const user = os.userInfo().username;
  devIdentity = { key: (email || `${user}@${os.hostname()}`).toLowerCase(), name: name || user, email, machine: os.hostname() };
  return devIdentity;
}

// ---------- Claude Code ----------
function listFiles(dir, ...exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  }
  return out;
}
const SYSTEMISH = /^\s*<(command-name|command-message|command-args|local-command|system-reminder|ide_opened_file|ide_selection|task-notification)/;
function firstHumanText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "").trim())
    .filter(Boolean);
  if (!texts.length) return null;
  return texts.join(" ");
}
function parseClaudeFile(file, sessions, touched) {
  let raw;
  try { raw = readLog(file); } catch { return; }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object") continue;
    const sid = o.sessionId; if (!sid) continue;
    const key = "claude-code:" + sid;
    if (touched) touched.add(key);
    let s = sessions.get(key);
    if (!s) { s = newSession("claude-code", sid); sessions.set(key, s); }
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!isNaN(ts)) { s._min = Math.min(s._min, ts); s._max = Math.max(s._max, ts); }
    if (o.cwd && !s.cwd) s.cwd = o.cwd;
    if (o.gitBranch && o.gitBranch !== "HEAD" && !s.branch) s.branch = o.gitBranch;
    if (o.version && !s.version) s.version = o.version;
    if (o.entrypoint && !s.entrypoint) s.entrypoint = o.entrypoint;
    const m = o.message;
    if (o.type === "user" && m && !o.isSidechain) {
      const t = firstHumanText(m.content);
      if (t && !SYSTEMISH.test(t)) {
        s.turns += 1;
        if (!s.first_prompt) s.first_prompt = t.replace(/\s+/g, " ").slice(0, 160);
      }
    } else if (o.type === "assistant" && m) {
      if (m.model && m.model !== "<synthetic>" && m.usage && m.id) {
        // Streamed rows repeat usage per content block, and forked subagent transcripts copy parent
        // rows, so dedupe by message.id across every file of the session, not just this file.
        // output_tokens only grows as a message streams, and a copy can be taken mid-stream, so a
        // row never replaces one that already saw more output, whichever file is parsed last.
        const prev = s._msgs.get(m.id);
        const keepPrev = prev && (prev.usage.output_tokens || 0) > (m.usage.output_tokens || 0);
        s._msgs.set(m.id, { usage: keepPrev ? prev.usage : m.usage, model: m.model, sidechain: !!o.isSidechain && (!prev || prev.sidechain) });
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || b.type !== "tool_use") continue;
          if (b.id) { if (s._toolIds.has(b.id)) continue; s._toolIds.add(b.id); }
          s.tool_calls[b.name] = (s.tool_calls[b.name] || 0) + 1;
          const fp = b.input && (b.input.file_path || b.input.notebook_path);
          if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) s._files.add(String(fp));
        }
      }
    }
  }
}
function tallyClaudeUsage(s) {
  for (const { usage, model: base, sidechain } of s._msgs.values()) {
    const model = usage.speed === "fast" ? base + ":fast" : base; // fast mode bills at a premium
    const mu = s.models[model] || (s.models[model] = { input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, requests: 0 });
    const cc = usage.cache_creation || {};
    const cw1h = cc.ephemeral_1h_input_tokens || 0;
    const cwTotal = usage.cache_creation_input_tokens || 0;
    mu.input += usage.input_tokens || 0;
    mu.output += usage.output_tokens || 0;
    mu.cache_write_1h += cw1h;
    mu.cache_write_5m += Math.max(0, cwTotal - cw1h);
    mu.cache_read += usage.cache_read_input_tokens || 0;
    mu.requests += 1;
    if (sidechain) s.subagent_output_tokens += usage.output_tokens || 0;
  }
  s._msgs.clear();
}

// ---------- Codex CLI (best effort; rollout JSONL format) ----------
function parseCodexFile(file, sessions, touched) {
  let raw; try { raw = readLog(file); } catch { return; }
  let s = null; let lastTotals = null; let model = null;
  let turns = 0; let firstPrompt = null; const calls = {};
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object") continue;
    const p = o.payload || {};
    if (o.type === "session_meta" && p.id) {
      const key = "codex:" + p.id;
      if (touched) touched.add(key);
      s = sessions.get(key) || newSession("codex", p.id); sessions.set(key, s);
      s.cwd = p.cwd || s.cwd; s.version = p.cli_version || s.version;
      if (p.git) { if (p.git.branch) s.branch = p.git.branch; if (p.git.repository_url) s._repoUrl = p.git.repository_url; }
    }
    if (!s) continue;
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!isNaN(ts)) { s._min = Math.min(s._min, ts); s._max = Math.max(s._max, ts); }
    if (o.type === "turn_context" && p.model) model = p.model;
    if (o.type === "event_msg" && p.type === "token_count" && p.info && p.info.total_token_usage) lastTotals = p.info.total_token_usage;
    if (o.type === "response_item") {
      if (p.type === "message" && p.role === "user") {
        const t = Array.isArray(p.content) ? p.content.map((c) => (c && c.text) || "").join(" ").trim() : String(p.content || "");
        if (t && !/^\s*[<#]/.test(t)) { turns += 1; if (!firstPrompt) firstPrompt = t.replace(/\s+/g, " ").slice(0, 160); }
      } else if ((p.type === "function_call" || p.type === "custom_tool_call") && p.name) {
        calls[p.name] = (calls[p.name] || 0) + 1;
      }
    }
  }
  if (s && lastTotals) {
    // total_token_usage is the session's running total, so the same session seen in two files (a
    // rollout and its compressed copy) must not be added twice: the most complete file wins outright.
    const size = (t) => (t.input_tokens || 0) + (t.output_tokens || 0);
    if (!s._codex || size(lastTotals) >= size(s._codex.totals)) {
      s._codex = { totals: lastTotals, model: model || "codex-unknown" };
      s.turns = turns; s.tool_calls = calls; s.first_prompt = firstPrompt;
    }
  }
}
function tallyCodexUsage(s) {
  if (!s._codex) return;
  const { totals, model } = s._codex;
  const cached = totals.cached_input_tokens || 0;
  s.models[model] = { input: Math.max(0, (totals.input_tokens || 0) - cached), output: totals.output_tokens || 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: cached, requests: 1 };
  s._codex = null;
}

function newSession(tool, id) {
  return { tool, session_id: id, cwd: null, branch: null, version: null, entrypoint: null, turns: 0, first_prompt: null,
    tool_calls: {}, models: {}, subagent_output_tokens: 0, _files: new Set(), _msgs: new Map(), _toolIds: new Set(), _min: Infinity, _max: -Infinity, _repoUrl: null, _codex: null };
}
function finalize(s, config) {
  const started = isFinite(s._min) ? new Date(s._min).toISOString() : null;
  const ended = isFinite(s._max) ? new Date(s._max).toISOString() : null;
  const repo = s._repoUrl ? normalizeRemote(s._repoUrl) : repoForCwd(s.cwd);
  const cwd = s.cwd || "";
  const files = [...s._files].map((f) => (cwd && f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : path.basename(f))).slice(0, 200);
  return {
    tool: s.tool, session_id: s.session_id, started_at: started, ended_at: ended, repo, branch: s.branch,
    cwd_name: cwd ? path.basename(cwd) : null, version: s.version, entrypoint: s.entrypoint, turns: s.turns,
    first_prompt: config.privacy ? null : s.first_prompt, tool_calls: s.tool_calls, files_touched: files, files_count: s._files.size,
    models: s.models, subagent_output_tokens: s.subagent_output_tokens,
  };
}

// ---------- sync ----------
async function sync(opts) {
  const config = readJson(CONFIG, null);
  if (!config || !config.token) { console.error("tallyhook: not installed. Run: node tallyhook.js install <token>"); process.exit(1); }
  const state = readJson(STATE, { files: {} });
  // A new collector version can count differently (0.1.3 fixed double-counted subagent copies), so
  // re-upload everything once after an upgrade (the server replaces each session's totals). Forgetting
  // the per-file state does that, and progress is saved per batch, so an interrupted run resumes.
  if (state.collectorVersion !== VERSION && !opts.dryRun) {
    state.files = {};
    state.collectorVersion = VERSION;
    writeJson(STATE, state);
  }
  if (opts.stopHook && state.lastAttemptAt && Date.now() - state.lastAttemptAt < STOP_SYNC_MIN_GAP_MS) return;
  const sessions = new Map();
  const changed = [];
  const files = listFiles(CLAUDE_PROJECTS, ".jsonl").map((f) => ({ f, kind: "claude" }))
    .concat(listFiles(CODEX_SESSIONS, ".jsonl", ...(CAN_ZSTD ? [".jsonl.zst"] : [])).map((f) => ({ f, kind: "codex" })));
  const sigs = new Map();
  for (const { f } of files) { try { const st = fs.statSync(f); sigs.set(f, `${st.size}:${Math.floor(st.mtimeMs)}`); } catch { /* vanished */ } }
  for (const { f, kind } of files) {
    const sig = sigs.get(f); if (!sig) continue;
    if (!opts.full && state.files[f] === sig) continue;
    changed.push({ f, kind, sig });
  }
  // A Claude Code session spans <sid>.jsonl plus <sid>/subagents/*.jsonl. The server replaces a
  // session's usage on upload, so whenever any file of a session changed, re-parse the whole group.
  const groupOf = (f) => f.replace(/\/subagents\/[^/]+\.jsonl$/, ".jsonl");
  const groups = new Set(changed.filter((c) => c.kind === "claude").map((c) => groupOf(c.f)));
  const toParse = new Map(changed.map((c) => [c.f, c]));
  for (const c of files) if (c.kind === "claude" && groups.has(groupOf(c.f)) && !toParse.has(c.f)) toParse.set(c.f, { ...c, sig: sigs.get(c.f) });
  const fileSessions = new Map();
  for (const { f, kind } of toParse.values()) {
    const before = new Set(sessions.keys());
    const touched = new Set();
    (kind === "claude" ? parseClaudeFile : parseCodexFile)(f, sessions, touched);
    for (const k of sessions.keys()) if (!before.has(k)) touched.add(k);
    fileSessions.set(f, touched);
  }
  for (const s of sessions.values()) (s.tool === "claude-code" ? tallyClaudeUsage : tallyCodexUsage)(s);
  const payload = [...sessions.values()].map((s) => finalize(s, config)).filter((s) => s.started_at && Object.keys(s.models).length);
  log(opts.quiet, `tallyhook: ${changed.length} changed file(s), ${payload.length} session(s) to upload`);
  if (opts.dryRun) {
    // Never touches the network. Prints a summary so the parser can be checked locally.
    const tot = payload.reduce((a, s) => { for (const m of Object.values(s.models)) { a.in += m.input; a.out += m.output; a.cr += m.cache_read; a.cw += m.cache_write_5m + m.cache_write_1h; } a.turns += s.turns; return a; }, { in: 0, out: 0, cr: 0, cw: 0, turns: 0 });
    const repos = {}; for (const s of payload) repos[s.repo] = (repos[s.repo] || 0) + 1;
    console.log(JSON.stringify({ sessions: payload.length, totals: tot, repos, sample: payload[0] }, null, 2));
    return;
  }
  const dev = getDev(config);
  state.lastAttemptAt = Date.now();
  writeJson(STATE, state); // throttle counts attempts, so an unreachable API never stalls every turn
  let uploaded = 0;
  const fail = (msg) => {
    console.error("tallyhook: " + msg);
    process.exit(opts.hook ? 0 : 1); // never fail a Claude Code hook; the next sync retries
  };
  // Remember which sessions each file produced, so progress can be saved after every batch: a big
  // re-upload that a 20s hook timeout cuts short resumes where it stopped instead of starting over.
  const pending = new Map(); // file -> number of its sessions not yet uploaded
  const filesOf = new Map(); // session key -> files
  for (const [f, keys] of fileSessions) for (const k of keys) { if (!filesOf.has(k)) filesOf.set(k, []); filesOf.get(k).push(f); }
  for (const s of payload) for (const f of filesOf.get(s.tool + ":" + s.session_id) || []) pending.set(f, (pending.get(f) || 0) + 1);
  for (const { f, sig } of toParse.values()) if (sig && !pending.has(f)) state.files[f] = sig; // produced nothing to upload
  for (let i = 0; i < payload.length; i += 40) {
    const batch = payload.slice(i, i + 40);
    let res;
    try {
      res = await fetch(config.api.replace(/\/$/, "") + "/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.token, "User-Agent": "tallyhook-collector/" + VERSION },
        body: JSON.stringify({ collector: VERSION, dev, sessions: batch }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) { return fail(`could not reach ${config.api} (${e && e.name === "TimeoutError" ? "timeout" : e && e.message}); will retry on the next sync`); }
    if (!res.ok) { const t = await res.text(); return fail(`upload failed (${res.status}): ${t.slice(0, 300)}`); }
    uploaded += batch.length;
    for (const x of batch) for (const f of filesOf.get(x.tool + ":" + x.session_id) || []) {
      const left = pending.get(f) - 1;
      pending.set(f, left);
      if (left === 0 && sigs.get(f)) state.files[f] = sigs.get(f);
    }
    writeJson(STATE, state);
  }
  state.lastSyncAt = Date.now();
  writeJson(STATE, state);
  log(opts.quiet, `tallyhook: uploaded ${uploaded} session(s) as ${dev.key}`);
}

// ---------- report (local only) ----------
// Prints what each repo cost on this machine. Needs no account and uploads nothing: the one network
// call is a GET for the public price list. Matching mirrors the server's: exact or dated model ids only.
function priceOf(model, table) {
  const m = model.toLowerCase();
  for (const p of table) {
    if (m === p.key) return p;
    if (!m.startsWith(p.key)) continue;
    const [ver, mode] = m.slice(p.key.length).split(":");
    if (mode !== undefined && !p.key.includes(":")) continue;
    if (/^(-\d{4}(-?\d{2}){0,2}|-latest|@[\w.-]+)$/.test(ver)) return p;
  }
  return null;
}
// Read every local session, price it, and return the numbers. Shared by `report` (which formats
// them for a person) and `mcp` (which hands them to an agent), so the two can never disagree.
// Writes nothing to stdout: the MCP transport owns stdout and one stray log line corrupts it.
// Parsing every local log is the expensive half -- on a heavy machine it is ten seconds of
// straight-line CPU. `report` does it once and exits, but the MCP server is long-lived and an agent
// asks several questions in a row, so both halves are memoised per process.
//
// This is not just a speed nicety. Parsing is synchronous, so it blocks the event loop: two
// concurrent calls used to starve each other's price fetch past its 8s timeout and silently return
// every cost as null. Caching plus in-flight sharing means one parse serves them all.
const CACHE_TTL_MS = 60000;
let _sessionsCache = null; // { at, promise }
let _pricesCache = null;   // { at, api, promise }

function loadSessions() {
  if (_sessionsCache && Date.now() - _sessionsCache.at < CACHE_TTL_MS) return _sessionsCache.promise;
  const promise = (async () => {
    const sessions = new Map();
    const files = listFiles(CLAUDE_PROJECTS, ".jsonl").map((f) => ({ f, kind: "claude" }))
      .concat(listFiles(CODEX_SESSIONS, ".jsonl", ...(CAN_ZSTD ? [".jsonl.zst"] : [])).map((f) => ({ f, kind: "codex" })));
    for (const { f, kind } of files) { try { (kind === "claude" ? parseClaudeFile : parseCodexFile)(f, sessions, new Set()); } catch { /* unreadable file: skip */ } }
    for (const s of sessions.values()) (s.tool === "claude-code" ? tallyClaudeUsage : tallyCodexUsage)(s);
    return [...sessions.values()].map((s) => finalize(s, {})).filter((s) => s.started_at && Object.keys(s.models).length);
  })();
  _sessionsCache = { at: Date.now(), promise };
  // A failed parse must not be cached as the answer for the next minute.
  promise.catch(() => { if (_sessionsCache && _sessionsCache.promise === promise) _sessionsCache = null; });
  return promise;
}

function loadPrices(api) {
  if (_pricesCache && _pricesCache.api === api && Date.now() - _pricesCache.at < CACHE_TTL_MS) return _pricesCache.promise;
  const promise = (async () => {
    try {
      const res = await fetch(api + "/api/prices", { headers: { "User-Agent": "tallyhook-collector/" + VERSION }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return (await res.json()).models;
    } catch { /* offline: report tokens only */ }
    return null;
  })();
  _pricesCache = { at: Date.now(), api, promise };
  // Don't cache "offline" for a minute -- the next question deserves a fresh attempt.
  promise.then((t) => { if (!t && _pricesCache && _pricesCache.promise === promise) _pricesCache = null; });
  return promise;
}

async function gather(days, api) {
  days = Math.max(1, Math.min(3650, parseInt(days, 10) || 30));
  api = (api || (readJson(CONFIG, null) || {}).api || "https://tallyhook.dev").replace(/\/$/, "");
  const all = await loadSessions();
  const since = Date.now() - days * 86400000;
  const prevSince = since - days * 86400000; // the equally long window immediately before, for the trend line
  const rows = all.filter((s) => Date.parse(s.started_at) >= since).map((s) => ({ ...s }));
  const prevRows = all.filter((s) => { const t = Date.parse(s.started_at); return t >= prevSince && t < since; });
  const table = await loadPrices(api);
  const unpriced = new Set();
  const costOfModel = (model, u) => {
    const p = table && priceOf(model, table);
    if (!p) { unpriced.add(model); return 0; }
    return (u.input * p.input + u.output * p.output + u.cache_write_5m * p.cache_write + u.cache_write_1h * p.input * 2 + u.cache_read * p.cache_read) / 1e6;
  };
  const costOf = (s) => Object.entries(s.models).reduce((c, [model, u]) => c + costOfModel(model, u), 0);
  let total = 0;
  for (const s of rows) { s._cost = costOf(s); total += s._cost; }
  const prevTotal = prevRows.reduce((n, s) => n + costOf(s), 0);
  return { days, api, table, priced: !!table, rows, prevRows, total, prevTotal, unpriced, costOfModel };
}

// Rank by repo or by model. A session that spanned two models has its cost split between them, so
// the model column still totals to the same number as the repo column.
function rank(g, by_model) {
  const by = new Map();
  for (const s of g.rows) {
    if (by_model) {
      for (const [model, u] of Object.entries(s.models)) {
        const a = by.get(model) || { key: model, sessions: 0, out: 0, cost: 0 };
        a.sessions++; a.cost += g.costOfModel(model, u); a.out += u.output;
        by.set(model, a);
      }
    } else {
      const k = s.repo || "(no repo)";
      const a = by.get(k) || { key: k, sessions: 0, out: 0, cost: 0 };
      a.sessions++; a.cost += s._cost; a.out += Object.values(s.models).reduce((n, u) => n + u.output, 0);
      by.set(k, a);
    }
  }
  return [...by.values()].sort((a, b) => b.cost - a.cost || b.out - a.out);
}

function summaryOf(g, by_model) {
  return {
    days: g.days,
    generated_at: new Date().toISOString(),
    priced: g.priced,
    sessions: g.rows.length,
    total_cost_usd: g.priced ? Number(g.total.toFixed(4)) : null,
    previous_period: { sessions: g.prevRows.length, total_cost_usd: g.priced ? Number(g.prevTotal.toFixed(4)) : null },
    unpriced_models: [...g.unpriced],
    [by_model ? "models" : "repos"]: rank(g, by_model).map((r) => ({
      [by_model ? "model" : "repo"]: r.key,
      sessions: r.sessions,
      output_tokens: r.out,
      cost_usd: g.priced ? Number(r.cost.toFixed(4)) : null,
    })),
  };
}

async function report(days, api, { json = false, groupBy = "repo" } = {}) {
  const g = await gather(days, api);
  const by_model = groupBy === "model";
  if (!g.rows.length) {
    if (json) { console.log(JSON.stringify({ days: g.days, sessions: 0, total_cost_usd: 0, [by_model ? "models" : "repos"]: [] }, null, 2)); return; }
    console.log(`tallyhook: no Claude Code or Codex sessions found in the last ${g.days} days on this machine.`); return;
  }
  // --json exists so this is usable from a script without parsing a table that is formatted for
  // people. Same numbers, no prose, and it stays quiet about anything it could not price.
  if (json) { console.log(JSON.stringify(summaryOf(g, by_model), null, 2)); return; }
  const { table, total, prevTotal, rows, prevRows, unpriced, days: d, api: apiUrl } = g;
  const usd = (n) => "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
  const list = rank(g, by_model);
  const w = Math.min(56, Math.max(10, ...list.map((r) => r.key.length)));
  const clip = (t) => (t.length > w ? "…" + t.slice(-(w - 1)) : t.padEnd(w));
  console.log(`\nAI coding-agent usage on this machine, last ${d} days${table ? " (public API list prices)" : " (price list unreachable, tokens only)"}\n`);
  console.log(`${(by_model ? "MODEL" : "REPO").padEnd(w)}  ${"SESSIONS".padStart(8)}  ${"OUTPUT".padStart(8)}  ${"LIST COST".padStart(11)}`);
  for (const r of list.slice(0, 25)) console.log(`${clip(r.key)}  ${String(r.sessions).padStart(8)}  ${tok(r.out).padStart(8)}  ${(table ? usd(r.cost) : "").padStart(11)}`);
  if (list.length > 25) console.log(`… and ${list.length - 25} more ${by_model ? "models" : "repos"}`);
  console.log(`${"TOTAL".padEnd(w)}  ${String(rows.length).padStart(8)}  ${tok(list.reduce((n, r) => n + r.out, 0)).padStart(8)}  ${(table ? usd(total) : "").padStart(11)}`);
  if (table) {
    const top = rows.slice().sort((a, b) => b._cost - a._cost)[0];
    if (prevRows.length) {
      const pct = prevTotal > 0.005 ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;
      const dir = total >= prevTotal ? "up" : "down";
      console.log(`\nPrevious ${d} days: ${usd(prevTotal)} across ${prevRows.length} session${prevRows.length === 1 ? "" : "s"}${pct === null ? "" : ` — ${dir} ${Math.abs(pct)}%`}.`);
    }
    console.log(`\nMost expensive session: ${usd(top._cost)} in ${top.repo || "(no repo)"}, started ${top.started_at.slice(0, 10)}.`);
    if (unpriced.size) console.log(`No list price for: ${[...unpriced].join(", ")} (counted as $0).`);
    console.log("List price is what this usage would cost on the API. On a subscription it is the value you used, not a bill.");
  }
  console.log(`\nNothing was uploaded. To see this across a team, per client, with invoices: ${apiUrl}\n`);
}

// ---------- mcp ----------
// A Model Context Protocol server over stdio, so an agent can ask what its own work has cost.
// Deliberately local and account-free: the same files `report` reads, no token, nothing uploaded.
// JSON-RPC 2.0, newline-delimited, hand-rolled because this package has no dependencies and one
// small protocol is not worth changing that.
//
// The hard rule here is that stdout belongs to the protocol. Any stray console.log corrupts the
// stream and the client drops the connection, which is why gather() prints nothing and every
// diagnostic below goes to stderr.
const MCP_TOOLS = [
  {
    name: "usage_by_repo",
    description: "What AI coding-agent sessions on this machine cost, grouped by git repository, over the last N days. Reads local Claude Code and Codex logs. Nothing is uploaded.",
    inputSchema: { type: "object", properties: { days: { type: "integer", description: "Window in days (default 30, max 3650).", minimum: 1, maximum: 3650 } } },
  },
  {
    name: "usage_by_model",
    description: "The same spend grouped by model instead of repository. A session spanning two models has its cost split between them, so the totals agree with usage_by_repo.",
    inputSchema: { type: "object", properties: { days: { type: "integer", description: "Window in days (default 30, max 3650).", minimum: 1, maximum: 3650 } } },
  },
  {
    name: "expensive_sessions",
    description: "The individual sessions that cost the most, newest window first. Use this to find a runaway agent loop rather than a general trend.",
    inputSchema: { type: "object", properties: { days: { type: "integer", description: "Window in days (default 30, max 3650).", minimum: 1, maximum: 3650 }, limit: { type: "integer", description: "How many sessions to return (default 10, max 100).", minimum: 1, maximum: 100 } } },
  },
  {
    name: "usage_summary",
    description: "Total spend and session count for the window, compared against the equally long window immediately before it. Answers 'am I spending more than last month'.",
    inputSchema: { type: "object", properties: { days: { type: "integer", description: "Window in days (default 30, max 3650).", minimum: 1, maximum: 3650 } } },
  },
];

async function mcpCall(name, args) {
  const days = args && args.days;
  if (name === "usage_by_repo") return summaryOf(await gather(days), false);
  if (name === "usage_by_model") return summaryOf(await gather(days), true);
  if (name === "usage_summary") {
    const g = await gather(days);
    const pct = g.priced && g.prevTotal > 0.005 ? Math.round(((g.total - g.prevTotal) / g.prevTotal) * 100) : null;
    return {
      days: g.days, generated_at: new Date().toISOString(), priced: g.priced,
      sessions: g.rows.length,
      total_cost_usd: g.priced ? Number(g.total.toFixed(4)) : null,
      previous_period: { sessions: g.prevRows.length, total_cost_usd: g.priced ? Number(g.prevTotal.toFixed(4)) : null },
      change_pct: pct,
      repos: rank(g, false).length,
      unpriced_models: [...g.unpriced],
      note: "List price is what this usage would cost on the API. On a subscription it is the value of what you used, not a bill.",
    };
  }
  if (name === "expensive_sessions") {
    const g = await gather(days);
    const limit = Math.max(1, Math.min(100, parseInt(args && args.limit, 10) || 10));
    // Honour the same privacy switch the uploader does: if the user turned prompt capture off,
    // an agent reading this server does not get the prompt either.
    const privacy = !!(readJson(CONFIG, null) || {}).privacy;
    return {
      days: g.days, generated_at: new Date().toISOString(), priced: g.priced,
      sessions: g.rows.slice().sort((a, b) => b._cost - a._cost).slice(0, limit).map((s) => ({
        repo: s.repo || null, branch: s.branch, tool: s.tool,
        started_at: s.started_at, ended_at: s.ended_at, turns: s.turns,
        files_touched: s.files_count,
        cost_usd: g.priced ? Number(s._cost.toFixed(4)) : null,
        models: Object.keys(s.models),
        first_prompt: privacy ? null : s.first_prompt,
      })),
    };
  }
  throw new Error("unknown tool: " + name);
}

function mcp() {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { fail(null, -32700, "parse error"); continue; }
      handle(msg);
    }
  });
  // Requests are async (reading logs, fetching the price table), so exiting the moment stdin closes
  // would abandon whatever is still in flight. Found by testing with piped input, where stdin ends
  // immediately: one reply went missing entirely and another came back unpriced because its price
  // fetch never finished. Exit only once nothing is outstanding.
  let pending = 0, ended = false;
  const done = () => { if (--pending === 0 && ended) process.exit(0); };
  process.stdin.on("end", () => { ended = true; if (pending === 0) process.exit(0); });

  async function handle(msg) {
    const { id, method, params } = msg || {};
    // A notification has no id and must never be answered, including the unknown ones.
    if (id === undefined || id === null) return;
    pending++;
    try {
      if (method === "initialize") {
        const asked = params && typeof params.protocolVersion === "string" ? params.protocolVersion : null;
        return reply(id, {
          protocolVersion: asked || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "tallyhook", version: VERSION },
          instructions: "Reports what Claude Code and Codex sessions on this machine have cost, grouped by git repository, by model, or session by session. Everything is computed locally from logs the tools already wrote; the only network call is fetching the public price table. Costs are list-price equivalents, so on a subscription they are the value of what you used rather than a bill.",
        });
      }
      if (method === "ping") return reply(id, {});
      if (method === "tools/list") return reply(id, { tools: MCP_TOOLS });
      if (method === "tools/call") {
        const name = params && params.name;
        try {
          const out = await mcpCall(name, (params && params.arguments) || {});
          // Tool failures are results with isError, not JSON-RPC errors, so the model can read and
          // recover from them rather than the client treating it as a transport fault.
          return reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false });
        } catch (e) {
          return reply(id, { content: [{ type: "text", text: "tallyhook: " + (e && e.message ? e.message : String(e)) }], isError: true });
        }
      }
      return fail(id, -32601, "method not found: " + method);
    } catch (e) {
      fail(id, -32603, e && e.message ? e.message : String(e));
    } finally {
      done();
    }
  }
}

// ---------- install / uninstall ----------
function hookCommand(event) {
  const self = path.join(DIR, "tallyhook.js");
  // Absolute interpreter path: hooks run in a non-login shell where nvm/fnm shims may be missing.
  return { type: "command", command: `"${process.execPath}" "${self}" sync --quiet --hook${event === "Stop" ? " --stop-hook" : ""}`, timeout: 20 };
}
function install(token, api) {
  if (!token) { console.error("usage: node tallyhook.js install <token> [--api URL]"); process.exit(1); }
  fs.mkdirSync(DIR, { recursive: true });
  const self = path.join(DIR, "tallyhook.js");
  if (path.resolve(__filename) !== self) fs.copyFileSync(__filename, self);
  const prev = readJson(CONFIG, {});
  writeJson(CONFIG, { ...prev, token, api: api || prev.api || "https://tallyhook.dev", privacy: prev.privacy || false });
  const settings = readSettings();
  settings.hooks = settings.hooks || {};
  for (const ev of ["SessionEnd", "Stop"]) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const filtered = list.filter((g) => !JSON.stringify(g).includes("tallyhook.js"));
    filtered.push({ hooks: [hookCommand(ev)] });
    settings.hooks[ev] = filtered;
  }
  writeJson(CLAUDE_SETTINGS, settings);
  console.log(`tallyhook: installed to ${self}\n- Claude Code hooks registered (SessionEnd, Stop) in ${CLAUDE_SETTINGS}\n- Uploading history now...`);
  return sync({ full: true });
}
function uninstall() {
  const settings = readSettings();
  if (settings.hooks) for (const ev of Object.keys(settings.hooks)) settings.hooks[ev] = (settings.hooks[ev] || []).filter((g) => !JSON.stringify(g).includes("tallyhook.js"));
  writeJson(CLAUDE_SETTINGS, settings);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* already gone */ }
  console.log("tallyhook: hooks removed and ~/.tallyhook deleted.");
}
function status() {
  const c = readJson(CONFIG, null); const st = readJson(STATE, { files: {} });
  if (!c) return console.log("tallyhook: not installed");
  console.log(`api: ${c.api}\ntoken: ...${c.token.slice(-6)}\nprivacy (no prompts): ${!!c.privacy}\ntracked files: ${Object.keys(st.files).length}\nlast sync: ${st.lastSyncAt ? new Date(st.lastSyncAt).toISOString() : "never"}\ndev: ${getDev(c).key}`);
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n) => rest.includes(n);
  const val = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (cmd === "install") await install(rest.find((a) => !a.startsWith("--")), val("--api"));
    else if (cmd === "sync") await sync({ quiet: flag("--quiet"), full: flag("--full"), dryRun: flag("--dry-run"), stopHook: flag("--stop-hook"), hook: flag("--hook") || flag("--stop-hook") });
    else if (cmd === "report") await report(val("--days"), val("--api"), { json: flag("--json"), groupBy: val("--by") === "model" ? "model" : "repo" });
    else if (cmd === "mcp") mcp();
    else if (cmd === "status") status();
    else if (cmd === "uninstall") uninstall();
    else console.log("tallyhook collector v" + VERSION + "\n  install <token> [--api URL]\n  sync [--quiet] [--full] [--dry-run]\n  status\n  uninstall\n  report [--days 30] [--by model] [--json]   (local only, nothing uploaded)\n  mcp                                       (MCP server over stdio, local only, no account)");
  } catch (e) {
    console.error("tallyhook: " + (e && e.message ? e.message : e));
    // A sync running from a Claude Code hook must never block a turn, even for an error this
    // outer catch-all didn't anticipate (sync()'s own fail() helper already does this for network
    // errors specifically -- this covers everything else, e.g. writeJson failing on a full disk).
    process.exit(cmd === "sync" && (flag("--hook") || flag("--stop-hook")) ? 0 : 1);
  }
})();
