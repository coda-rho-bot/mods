/**
 * Oath Keeper — Letta Code Mod
 *
 * "Cron is for things you plan. Oath Keeper is for things you promise."
 *
 * Architecture:
 * - Detection: turn_end (CLI v0.27.25+) + setInterval polling (desktop/listener)
 * - Delivery: queued state + API POST with 409 retry
 * - State: local JSON file with builder-pattern StateStore
 *
 * CLI LIMITATION: Oath delivery fires into the conversation via API POST.
 * The delivery appears in the desktop app. CLI may not display it until
 * the next user message or CLI restart.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

const HOME = os.homedir();
const STATE_FILE = `${HOME}/.letta/mods/oath-keeper.state.json`;
const ENV_FILE = `${HOME}/.letta/extensions/oath-env.json`;
const DEBUG_FILE = `${HOME}/.letta/mods/oath-keeper-debug.json`;
const FALSE_POSITIVE_FILE = `${HOME}/.letta/mods/oath-keeper-false-positives.json`;
const POLL_INTERVAL_MS = 15_000;
const DEFAULT_DELAY_MS = 300_000; // 5 minutes fallback if LLM doesn't specify
const VERBOSE_FILE = `${HOME}/.letta/mods/oath-keeper.verbose`;
const CONFIG_FILE = `${HOME}/.letta/mods/oath-keeper.config.json`;
const APP_SERVER_PORT = 4500;
const DELIVERY_SCRIPT = `${HOME}/.letta/scripts/deliver-oath.mjs`;
let appServerProcess: ReturnType<typeof spawn> | null = null;

// ─── App Server Management ───────────────────────────────────────
// The App Server provides a websocket endpoint that the Agent SDK connects to.
// This ensures delivery has full tool access (Bash, Read, Edit, Write),
// unlike the REST API which only provides server-side tools via cloud relay.

function discoverLettaBinary(): string {
  // Try the shell shim first — it's maintained by the desktop app and always points to the working mount
  const shim = "/tmp/letta-code-shell-shim/letta";
  if (fs.existsSync(shim)) return shim;
  // Fallback: find a working mount (not just one that exists — broken mounts have stale dirs)
  try {
    const mounts = fs.readdirSync("/tmp").filter(d => d.startsWith(".mount_letta-"));
    for (const mount of mounts) {
      const binary = `/tmp/${mount}/letta-code`;
      const js = `/tmp/${mount}/resources/app.asar.unpacked/node_modules/@letta-ai/letta-code/letta.js`;
      try {
        // Actually try to access the binary — broken mounts will throw
        fs.accessSync(binary, fs.constants.X_OK);
        fs.accessSync(js, fs.constants.R_OK);
        return `${binary} ${js}`;
      } catch (e) { /* mount is broken, try next */ }
    }
  } catch (e) {}
  return "";
}

function isAppServerRunning(): boolean {
  try {
    // The App Server is a WebSocket server, not HTTP — /v1/health won't work.
    // Just check if the port is listening.
    const result = execSync(`ss -tlnp 2>/dev/null | grep '127.0.0.1:${APP_SERVER_PORT}' | grep -q LISTEN && echo yes || echo no`, { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    return result === "yes";
  } catch (e) { return false; }
}

function startAppServer(): void {
  if (isAppServerRunning()) { log("App Server already running on port " + APP_SERVER_PORT); return; }
  const binary = discoverLettaBinary();
  if (!binary) { log("Cannot start App Server — no working letta binary found"); return; }
  // The shim is a single path; the raw binary needs the js path appended
  const parts = binary.split(" ");
  log("Starting App Server: " + binary + " server --listen ws://127.0.0.1:" + APP_SERVER_PORT);
  try {
    appServerProcess = spawn(parts[0], [...parts.slice(1), "server", "--listen", "ws://127.0.0.1:" + APP_SERVER_PORT], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, HOME: HOME },
      detached: false,
    });
    appServerProcess.on("error", (e: any) => log("App Server error: " + e));
    appServerProcess.on("exit", (code: any, signal: any) => log("App Server exited: code=" + code + " signal=" + signal));
    log("App Server spawned PID=" + appServerProcess.pid);
  } catch (e) { log("Failed to start App Server: " + e); }
}

function stopAppServer(): void {
  if (appServerProcess) {
    try { appServerProcess.kill("SIGTERM"); } catch (e) {}
    appServerProcess = null;
    log("App Server stopped");
  }
}

function isVerbose(): boolean {
  try { return fs.existsSync(VERBOSE_FILE); } catch (e) { return false; }
}

interface OathConfig {
  classifierAgentId?: string; // Agent ID to use for promise classification (defaults to same agent)
  classifierModel?: string;   // Model for classification LLM calls (default: letta/auto-fast)
  negativeFilter?: boolean;    // Enable negative filter — code-heavy/short messages (default: true)
  ngramFilter?: boolean;       // Enable n-gram pre-filter (default: true)
  ngramThreshold?: number;     // N-gram score threshold for LLM classification (default: 1.25)
  llmConfirm?: boolean;        // Enable LLM confirmation/dedup (default: true)
  llmDedup?: boolean;          // Enable LLM semantic dedup (default: true)
}

function loadConfig(): OathConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

/** Get the agent ID to use for LLM classification calls.
 *  Falls back to the env file's agent ID if not configured. */
function getClassifierAgentId(): string {
  const config = loadConfig();
  if (config.classifierAgentId) return config.classifierAgentId;
  return getApiConfig().agentId;
}

/** Get the model to use for classification LLM calls (default: letta/auto-fast) */
function getClassifierModel(): string {
  const config = loadConfig();
  return config.classifierModel || "letta/auto-fast";
}

/** Check if negative filter is enabled (default: true) */
function isNegativeFilterEnabled(): boolean {
  const config = loadConfig();
  return config.negativeFilter !== false; // default true
}

/** Check if n-gram pre-filter is enabled (default: true) */
function isNgramEnabled(): boolean {
  const config = loadConfig();
  return config.ngramFilter !== false; // default true
}

/** Get n-gram score threshold (default: 1.25) */
function getNgramThreshold(): number {
  const config = loadConfig();
  return typeof config.ngramThreshold === "number" ? config.ngramThreshold : 1;
}

/** Check if LLM confirmation is enabled (default: false) */
function isLlmConfirmEnabled(): boolean {
  const config = loadConfig();
  return config.llmConfirm === true; // default false
}

/** Check if LLM semantic dedup is enabled (default: false) */
function isLlmDedupEnabled(): boolean {
  const config = loadConfig();
  return config.llmDedup === true; // default false
}

/** Check if at least one filter is active — if not, no oaths are created */
function filtersActive(): boolean {
  return isNgramEnabled() || isLlmConfirmEnabled();
}

function log(msg: string) {
  addDebugLog(msg);
  if (isVerbose()) console.log("[oath-keeper] " + msg);
}

// ─── Debug log ───────────────────────────────────────────────────

interface DebugEntry { ts: number; msg: string; }

function addDebugLog(msg: string) {
  try {
    const entry: DebugEntry = { ts: Date.now(), msg };
    const raw = fs.readFileSync(DEBUG_FILE, "utf8");
    const entries: DebugEntry[] = JSON.parse(raw);
    entries.push(entry);
    while (entries.length > 500) entries.shift();
    fs.writeFileSync(DEBUG_FILE, JSON.stringify(entries, null, 2));
  } catch (e) {
    try { fs.writeFileSync(DEBUG_FILE, JSON.stringify([{ ts: Date.now(), msg }], null, 2)); } catch (e2) {}
  }
}

// ─── State ───────────────────────────────────────────────────────

interface Oath {
  id: string;
  conversationId: string;
  agentId: string;
  promise: string;
  context: string;
  sourceMessageId?: string;
  deliveryMode?: "turn_end" | "rest_api" | "polling" | "sdk";
  createdAt: number;
  dueAt: number;
  status: "pending" | "queued" | "delivering" | "delivered" | "failed" | "false_positive" | "prefilter_rejected";
  result: string | null;
  deliveredAt: number | null;
  ngramScore?: number;
  llmTokens?: { prompt: number; completion: number; total: number };
}

interface StateData {
  oaths: Oath[];
  lastScannedMessageId: string | null;
  lastScannedMessageIds: Record<string, string> | null;
  _pollVer: string;
  purgeEpoch?: number;
}

class StateStore {
  private data: StateData;
  private dirty: boolean = false;
  private saved: boolean = false;
  private operation: string;

  private constructor(data: StateData, operation: string) { this.data = data; this.operation = operation; }

  static load(operation: string): StateStore {
    let data: StateData;
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      data = { oaths: parsed.oaths || [], lastScannedMessageId: parsed.lastScannedMessageId || null, lastScannedMessageIds: parsed.lastScannedMessageIds || null, _pollVer: parsed._pollVer || "", purgeEpoch: parsed.purgeEpoch || 0 };
      // Drop any oaths from before the last purge (handles race: mod loaded pre-purge, saves post-purge)
      if (data.purgeEpoch) {
        const before = data.oaths.length;
        data.oaths = data.oaths.filter((o) => o.createdAt > data.purgeEpoch!);
        if (before !== data.oaths.length) log(`StateStore.load: dropped ${before - data.oaths.length} pre-purge oaths`);
      }
    } catch (e) {
      data = { oaths: [], lastScannedMessageId: null, lastScannedMessageIds: null, _pollVer: "" };
    }
    log(`StateStore.load("${operation}") — ${data.oaths.length} oaths`);
    return new StateStore(data, operation);
  }

  findOath(id: string): Oath | undefined { return this.data.oaths.find((o) => o.id === id); }
  updateOath(id: string, updates: Partial<Oath>): StateStore {
    const oath = this.findOath(id);
    if (!oath) return this;
    Object.assign(oath, updates);
    this.dirty = true;
    log(`StateStore.updateOath("${id}") — ${Object.keys(updates).join(",")}`);
    return this;
  }
  addOath(oath: Oath): StateStore { this.data.oaths.push(oath); this.dirty = true; log(`StateStore.addOath("${oath.id}")`); return this; }
  setScanned(msgId: string): StateStore { this.data.lastScannedMessageId = msgId; this.dirty = true; return this; }
  setScannedForAgent(agentId: string, msgId: string): StateStore {
    if (!this.data.lastScannedMessageIds) this.data.lastScannedMessageIds = {};
    this.data.lastScannedMessageIds[agentId] = msgId;
    this.dirty = true;
    return this;
  }
  getScannedForAgent(agentId: string): string | null {
    return this.data.lastScannedMessageIds?.[agentId] || null;
  }
  setPollVer(ver: string): StateStore { this.data._pollVer = ver; this.dirty = true; return this; }
  prune(now: number): StateStore {
    const before = this.data.oaths.length;
    this.data.oaths = this.data.oaths.filter((o) => {
      // Always keep active oaths
      if (o.status === "pending" || o.status === "queued" || o.status === "delivering") return true;
      // Prune prefilter_rejected after 10 minutes (they're just debug noise)
      if (o.status === "prefilter_rejected" && o.deliveredAt && (now - o.deliveredAt) > 600_000) return false;
      // Prune llm_failed after 10 minutes
      if (o.status === "llm_failed" && o.deliveredAt && (now - o.deliveredAt) > 600_000) return false;
      if (o.status === "llm_failed" && (now - o.createdAt) > 600_000) return false;
      // Prune false_positive after 30 minutes
      if (o.status === "false_positive" && o.deliveredAt && (now - o.deliveredAt) > 1_800_000) return false;
      // Prune delivered/failed after 24 hours
      if (o.deliveredAt && (now - o.deliveredAt) > 86_400_000) return false;
      return true;
    });
    if (this.data.oaths.length !== before) this.dirty = true;
    return this;
  }
  get oaths(): Oath[] { return this.data.oaths; }
  get lastScannedMessageId(): string | null { return this.data.lastScannedMessageId; }
  get pollVer(): string { return this.data._pollVer; }
  setPurgeEpoch(ts: number): StateStore { this.data.purgeEpoch = ts; this.dirty = true; return this; }
  hasActiveOaths(): boolean { return this.data.oaths.some((o) => o.status === "pending" || o.status === "queued" || o.status === "delivering"); }

  /** Get active oaths (pending, queued, or delivering) for LLM dedup comparison */
  activeOaths(): Oath[] {
    return this.data.oaths.filter((o) => o.status === "pending" || o.status === "queued" || o.status === "delivering");
  }

  /** Strong dedup: returns true if an oath with the same promise text exists from the last N minutes */
  hasRecentPromise(promiseText: string, withinMs: number = 300_000): boolean {
    const now = Date.now();
    const snippet = promiseText.slice(0, 60).toLowerCase();
    return this.data.oaths.some((o) =>
      o.createdAt > (now - withinMs) &&
      o.promise.toLowerCase().includes(snippet)
    );
  }

  save(): void {
    if (!this.dirty) { this.saved = true; return; }
    try {
      // Merge disk changes before saving — prevents stale StateStore from
      // overwriting TUI mutations (purge, cancel, manual deliver)
      try {
        const disk = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        // Preserve purgeEpoch
        if (disk.purgeEpoch && disk.purgeEpoch > (this.data.purgeEpoch || 0)) {
          this.data.purgeEpoch = disk.purgeEpoch;
          const before = this.data.oaths.length;
          this.data.oaths = this.data.oaths.filter((o) => o.createdAt > disk.purgeEpoch);
          if (before !== this.data.oaths.length) log(`StateStore.save: dropped ${before - this.data.oaths.length} pre-purge oaths on save`);
        }
        // Preserve status changes from disk (e.g., TUI cancelled an oath)
        // If the disk version of an oath has a "terminal" status that our
        // in-memory version doesn't, adopt the disk version
        const diskOaths = new Map((disk.oaths || []).map((o: any) => [o.id, o]));
        for (const oath of this.data.oaths) {
          const diskOath = diskOaths.get(oath.id);
          if (diskOath && diskOath.status !== oath.status) {
            const terminal = ["failed", "delivered", "cancelled"];
            if (terminal.includes(diskOath.status) && !terminal.includes(oath.status)) {
              log(`StateStore.save: adopting disk status ${diskOath.status} for ${oath.id} (was ${oath.status})`);
              oath.status = diskOath.status;
              oath.result = diskOath.result;
              oath.deliveredAt = diskOath.deliveredAt;
            }
          }
        }
      } catch (e) { /* file might not exist yet */ }
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.data, null, 2)); this.saved = true; log(`StateStore.save() — SAVED after \"${this.operation}\"`); }
    catch (e) { log(`StateStore.save() — FAILED: ${e}`); }
  }
}

/** LLM dedup — checks if a new promise is semantically the same as any existing active oath */
async function isDuplicatePromise(newPromise: string, existingOaths: Oath[]): Promise<{ isDup: boolean; tokens?: { prompt: number; completion: number; total: number } }> {
  if (existingOaths.length === 0) return false;
  const { baseUrl, apiKey } = getApiConfig();
  const classifierAgentId = getClassifierAgentId();
  if (!classifierAgentId) return false;

  const list = existingOaths.map((o, i) => `${i + 1}. "${o.promise}"`).join("\n");
  const prompt =
    'You are a duplicate detector. A new oath promise has been detected.\n'
    + 'Check if it is semantically the same promise as any existing active oath.\n\n'
    + 'New promise: "' + newPromise + '"\n\n'
    + 'Existing active oaths:\n' + list + '\n\n'
    + 'Respond with ONLY a JSON object:\n'
    + '- Duplicate: {"is_duplicate": true, "matching_index": <number>}\n'
    + '- Not duplicate: {"is_duplicate": false}';

  try {
    const classifierModel = getClassifierModel();
    const convResp = await fetch(baseUrl + "/v1/conversations?agent_id=" + classifierAgentId, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
      body: JSON.stringify({ model: classifierModel }),
    });
    if (!convResp.ok) return { isDup: false };
    const convData: any = await convResp.json();
    const classConvId = convData.id || "";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const resp = await fetch(baseUrl + "/v1/conversations/" + classConvId + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
      body: JSON.stringify({ input: prompt, role: "user" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    try {
      await fetch(baseUrl + "/v1/conversations/" + classConvId, {
        method: "DELETE",
        headers: apiKey ? { Authorization: "Bearer " + apiKey } : {},
      });
    } catch (e) {}

    if (!resp.ok) return false;
    const respText = await resp.text();
    let answer = "";
    let tokenUsage: { prompt: number; completion: number; total: number } | undefined;
    for (const line of respText.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") break;
      try {
        const d = JSON.parse(data);
        if (d.message_type === "usage_statistics") {
          tokenUsage = { prompt: d.prompt_tokens || 0, completion: d.completion_tokens || 0, total: d.total_tokens || 0 };
        }
        if (d.message_type === "assistant_message" && d.content) {
          answer = String(d.content).slice(0, 500);
        }
      } catch (e) {}
    }

    const jsonMatch = answer.match(/\{[^}]*\}/);
    if (!jsonMatch) return { isDup: false, tokens: tokenUsage };
    const parsed = JSON.parse(jsonMatch[0]);
    const isDup = parsed.is_duplicate === true;
    if (isDup) log("isDuplicatePromise: DUPLICATE of oath #" + parsed.matching_index);
    else log("isDuplicatePromise: not a duplicate");
    return { isDup, tokens: tokenUsage };
  } catch (e) {
    log("isDuplicatePromise error: " + e);
    return { isDup: false };
  }
}

// ─── Promise Detection ───────────────────────────────────────────

const PROMISE_PATTERNS: Array<[RegExp, number]> = [
  // Strong signals (3.0)
  [/i'll get back to/i, 3.0],
  [/i'll follow up/i, 3.0],
  [/i'll circle back/i, 3.0],
  [/get back to you/i, 3.0],
  [/follow up (?:on|with|in)/i, 3.0],
  [/i'll let you know/i, 3.0],
  [/i'll update you/i, 3.0],
  [/check back (?:in|with|later|after)/i, 2.5],

  // Moderate signals (2.0-2.5)
  [/i'll (?:check|verify|look into|investigate|research|dig into|confirm)/i, 2.5],
  [/let me (?:check|verify|look into|investigate|research|dig into|confirm)/i, 2.5],
  [/i'll (?:send|provide|share|post|publish|deliver)/i, 2.0],
  [/i'll (?:have|get) (?:an answer|results|something|a response)/i, 2.5],
  [/i'll tell you.*(?:later|after|when)/i, 2.5],

  // Weak signals (1.0-1.5)
  [/i'll (?:try|attempt|see|find out|work on)/i, 1.5],
  [/i (?:will|shall) (?:check|verify|look|investigate|research|test|review|analyze)/i, 2.0],
  [/i'm going to (?:check|verify|look|investigate|research|test|review)/i, 2.0],
  [/(?:in|after) (?:\d+|a few|some) (?:minutes|seconds|hours|moments)/i, 1.5],
  [/\blater (?:today|this week|tonight)\b/i, 1.0],
];

function computeNgramScore(text: string): number {
  let score = 0;
  for (const [pattern, weight] of PROMISE_PATTERNS) {
    if (pattern.test(text)) score += weight;
  }
  return score;
}

function detectPromiseRegex(text: string): { match: string; score: number } | null {
  if (!text || typeof text !== "string") return null;
  if (text.includes("[Oath Keeper]") || text.includes("[Oath Delivered]")) return null;

  // Negative filter (Stage 0): skip short and code-heavy messages
  if (isNegativeFilterEnabled()) {
    if (text.trim().length < 15) return null;
    const codeChars = (text.match(/[{}()[\];=]/g) || []).length;
    if (text.length > 50 && codeChars / text.length > 0.05) return null;
  }

  const score = computeNgramScore(text);
  const threshold = getNgramThreshold();

  if (score > threshold) return { match: "ngram-score-" + score, score };
  return null;
}

/**
 * LLM confirmation — given a candidate message,
 * ask the LLM to determine whether it's a genuine promise to follow up later.
 * Returns the specific promise text or null if not a real promise.
 */
/** Log a false positive in the state file with its own status (deduplicated) */
function logFalsePositive(matchedPattern: string, text: string, source: string, ngramScore?: number, conversationId?: string, agentId?: string) {
  try {
    const store = StateStore.load("false-positive");
    // Deduplicate — skip if a false positive with the same text already exists
    const textSnippet = text.slice(0, 60);
    const exists = store.oaths.some((o) =>
      o.status === "false_positive" &&
      o.promise.includes(textSnippet)
    );
    if (exists) { log("False positive already logged — skipping duplicate"); return; }
    const now = Date.now();
    store.addOath({
      id: "fp-" + now + "-" + Math.random().toString(36).slice(2, 6),
      conversationId: conversationId || "",
      agentId: agentId || "",
      promise: "[FALSE POSITIVE] " + matchedPattern + ": " + text.slice(0, 60),
      context: text.slice(0, 200),
      createdAt: now,
      dueAt: now,
      status: "false_positive",
      result: "LLM rejected — not a genuine promise",
      deliveredAt: now,
      ngramScore,
    });
    store.save();
    log("False positive logged: " + matchedPattern);
  } catch (e) {
    log("Failed to log false positive: " + e);
  }
}

/** Log a pre-filter rejection — message didn't score high enough for LLM classification */
function logPreFilterRejection(text: string, reason: string, ngramScore?: number, conversationId?: string, agentId?: string) {
  try {
    const store = StateStore.load("prefilter-reject");
    const textSnippet = text.slice(0, 60);
    // Deduplicate — don't log the same rejection repeatedly
    const exists = store.oaths.some((o) =>
      o.status === "prefilter_rejected" &&
      o.promise.includes(textSnippet)
    );
    if (exists) return;
    const now = Date.now();
    store.addOath({
      id: "pf-" + now + "-" + Math.random().toString(36).slice(2, 6),
      conversationId: conversationId || "",
      agentId: agentId || "",
      promise: text.slice(0, 120),
      context: reason,
      createdAt: now,
      dueAt: now,
      status: "prefilter_rejected",
      result: reason,
      deliveredAt: now,
      ngramScore,
    });
    store.save();
    log("Pre-filter rejected: " + reason + " (score=" + (ngramScore ?? 0) + ") — " + textSnippet);
  } catch (e) {
    log("Failed to log pre-filter rejection: " + e);
  }
}

/**
 * LLM confirmation — given a candidate message that matched the regex pre-filter,
 * ask the LLM to confirm whether it's a genuine promise to follow up later.
 * Returns the specific promise text or null if not a real promise.
 */
async function confirmPromise(text: string): Promise<{ promise: string; delayMs: number; tokens?: { prompt: number; completion: number; total: number }; error?: boolean; status?: number } | null> {
  const { baseUrl, apiKey } = getApiConfig();
  const classifierAgentId = getClassifierAgentId();
  if (!classifierAgentId) return null;

  // Truncate to keep the classification fast
  const snippet = text.slice(0, 1000);
  const classificationPrompt =
    'You are a promise detector. Read this assistant message and determine:\n'
    + 'Does the assistant make a GENUINE promise to do something AFTER the current response?\n\n'
    + 'Rules:\n'
    + '- YES = agent commits to following up later (e.g., "I\'ll get back to you after I check")\n'
    + '- YES = agent says "I\'ll tell you X in 60 seconds" — the "in 60 seconds" means it will happen LATER\n'
    + '- YES = agent mentions a specific time delay ("in N minutes/seconds", "later", "after")\n'
    + '- NO = agent is doing it right now with no delay (e.g., "I\'ll tell you the time" immediately followed by the actual answer with no time gap)\n'
    + '- NO = quoting or explaining what someone else said\n'
    + '- NO = describing how the mod works\n'
    + '- NO = hypothetical examples\n\n'
    + 'Message:\n"""' + snippet + '"""\n\n'
    + 'Respond with ONLY a JSON object:\n'
    + '- Genuine promise: {"is_promise": true, "promise": "<what they specifically promise to do>", "delay_seconds": <integer>}\n'
    + '  - delay_seconds: how many seconds until the agent should deliver on this promise.\n'
    + '    - If the agent specified a time ("in 5 minutes" → 300, "in an hour" → 3600, "tomorrow" → 86400), use that.\n'
    + '    - If no specific time, estimate based on the task (quick check → 60-120, investigation → 300-600, deep work → 900+).\n'
    + '    - Any positive integer.\n'
    + '- Not a promise: {"is_promise": false}';

  try {
    // Create throwaway conversation for classification — use configured model
    const classifierModel = getClassifierModel();
    const convResp = await fetch(
      baseUrl + "/v1/conversations?agent_id=" + classifierAgentId,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
        body: JSON.stringify({ model: classifierModel }),
      }
    );
    if (!convResp.ok) { log("confirmPromise: could not create conversation"); return null; }
    const convData: any = await convResp.json();
    const classConvId = convData.id || "";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const resp = await fetch(
      baseUrl + "/v1/conversations/" + classConvId + "/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
        body: JSON.stringify({ input: classificationPrompt, role: "user" }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    // Cleanup conversation regardless of result
    try {
      await fetch(baseUrl + "/v1/conversations/" + classConvId, {
        method: "DELETE",
        headers: apiKey ? { Authorization: "Bearer " + apiKey } : {},
      });
    } catch (e) {}

    if (!resp.ok) { log("confirmPromise: classification API " + resp.status); return { error: true, status: resp.status }; }

    const respText = await resp.text();
    let answer = "";
    let tokenUsage: { prompt: number; completion: number; total: number } | undefined;
    for (const line of respText.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") break;
      try {
        const d = JSON.parse(data);
        if (d.message_type === "usage_statistics") {
          tokenUsage = {
            prompt: d.prompt_tokens || 0,
            completion: d.completion_tokens || 0,
            total: d.total_tokens || 0,
          };
        }
        if (d.message_type === "assistant_message" && d.content) {
          answer = String(d.content).slice(0, 2000);
        }
      } catch (e) {}
    }

    if (!answer) { log("confirmPromise: no response from LLM"); return null; }

    // Parse the JSON response
    const jsonMatch = answer.match(/\{[^}]*\}/);
    if (!jsonMatch) { log("confirmPromise: no JSON in response: " + answer.slice(0, 100)); return null; }

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.is_promise === true && parsed.promise && typeof parsed.promise === "string") {
      // Parse delay from LLM, clamp to sane bounds, default to 5 min if missing/invalid
      let delayMs = DEFAULT_DELAY_MS;
      if (typeof parsed.delay_seconds === "number" && parsed.delay_seconds > 0) {
        delayMs = parsed.delay_seconds * 1000;
      }
      log("confirmPromise: CONFIRMED — " + parsed.promise.slice(0, 60) + " (delay: " + (delayMs / 1000) + "s)");
      return { promise: parsed.promise.slice(0, 300), delayMs, tokens: tokenUsage };
    }
    log("confirmPromise: REJECTED — not a genuine promise");
    return null;
  } catch (e) {
    log("confirmPromise error: " + e);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function buildDeliveryPrompt(oath: Oath): string {
  let prompt = '[Oath Keeper] You previously promised the user:\n"' + oath.promise + '"\n\n'
    + 'Deliver on that promise now. You have full tool access — use whatever tools you need to follow through.\n'
    + 'Start your response with "[Oath Delivered]".';

  if (oath.context && oath.context !== "(turn_end)" && oath.context !== "(no context)") {
    prompt += '\n\nFor context, the user originally said:\n"' + oath.context + '"';
  }

  try {
    const now = new Date();
    const timeStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
    prompt += '\n\nCurrent time: ' + timeStr + ' CDT';
  } catch (e) {}

  return prompt;
}

function createOath(promise: string, context: string, conversationId: string, agentId: string, sourceMessageId?: string, deliveryMode?: "turn_end" | "polling", delayMs?: number): Oath {
  const now = Date.now();
  const due = now + (delayMs || DEFAULT_DELAY_MS);
  return { id: "oath-" + now + "-" + Math.random().toString(36).slice(2, 8), conversationId, agentId, promise, context, sourceMessageId, deliveryMode, createdAt: now, dueAt: due, status: "pending", result: null, deliveredAt: null };
}

// Cache the last-known-good port to avoid ss on every call
let cachedBaseUrl: string | null = null;
let lastPortCheck: number = 0;
const PORT_CHECK_INTERVAL = 60_000; // re-verify port every 60s

/** Discover the current Letta Code server port via ss.
 *  Called on startup to self-heal the stale env file. */
function discoverPort(): string | null {
  try {
    const output = execSync("ss -tlnp 2>/dev/null | grep letta-code | head -1 | grep -oP '127\\\\.0\\\\.0\\\\.1:\\\\K\\\\d+' 2>/dev/null", { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (output) return "http://localhost:" + output;
  } catch (e) {}
  return null;
}

/** Self-heal the env file on startup — discover the correct port and write it. */
function selfHealEnvFile() {
  try {
    let env: any = {};
    try { env = JSON.parse(fs.readFileSync(ENV_FILE, "utf8")); } catch (e) {}
    const currentPort = env.LETTA_BASE_URL || "";
    // Check if the port in the env file is alive
    let portAlive = false;
    if (currentPort) {
      try {
        const code = execSync(`curl -s -o /dev/null -w '%{http_code}' '${currentPort}/v1/health' --max-time 1 2>/dev/null`, { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).trim();
        portAlive = code === "200";
      } catch (e) {}
    }
    if (!portAlive) {
      const discovered = discoverPort();
      if (discovered) {
        env.LETTA_BASE_URL = discovered;
        // Ensure directory exists
        try { fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true }); } catch (e) {}
        fs.writeFileSync(ENV_FILE, JSON.stringify(env, null, 2));
        log("selfHealEnvFile: updated port to " + discovered);
        cachedBaseUrl = discovered;
        lastPortCheck = Date.now();
      }
    } else {
      cachedBaseUrl = currentPort;
      lastPortCheck = Date.now();
    }
  } catch (e) {
    log("selfHealEnvFile error: " + e);
  }
}

function getApiConfig() {
  let apiKey = process.env.LETTA_API_KEY;
  if (apiKey === "unset") apiKey = undefined;
  let agentId = "";
  let convId = "";
  const now = Date.now();

  // Read agent/conv IDs from env file (these don't change across restarts)
  try {
    const env = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));
    agentId = env.LETTA_AGENT_ID || "";
    convId = env.LETTA_CONVERSATION_ID || "";
  } catch (e) {}

  // Priority: cached (if checked recently) → process.env → env file → ss discovery → default
  // Re-verify the port every 60s to handle app restarts
  if (cachedBaseUrl && (now - lastPortCheck) < PORT_CHECK_INTERVAL) {
    return { baseUrl: cachedBaseUrl, apiKey, agentId, convId };
  }

  let baseUrl = "";
  let envPort = process.env.LETTA_BASE_URL || "";
  // Never use the cloud API for delivery — it doesn't have client-side tools (Bash, Read, Edit, Write).
  // Always prefer localhost. The cloud relay only provides server-side tools.
  if (envPort && envPort !== "unset" && envPort.includes("localhost")) baseUrl = envPort;

  if (!baseUrl) {
    try {
      const env = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));
      baseUrl = env.LETTA_BASE_URL || "";
    } catch (e) {}
  }

  // Verify the port is alive — if dead, discover via ss
  if (baseUrl) {
    try {
      const alive = execSync(`curl -s -o /dev/null -w '%{http_code}' '${baseUrl}/v1/health' --max-time 1 2>/dev/null`, { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (alive !== "200") {
        log("Port " + baseUrl + " is dead, discovering...");
        baseUrl = ""; // fall through to ss
      }
    } catch (e) {
      baseUrl = ""; // fall through to ss
    }
  }

  // ss discovery
  if (!baseUrl) {
    baseUrl = discoverPort() || "";
  }

  if (!baseUrl) baseUrl = "http://localhost:8283";

  cachedBaseUrl = baseUrl;
  lastPortCheck = now;

  addDebugLog("getApiConfig: baseUrl=" + baseUrl + " agentId=" + (agentId ? agentId.slice(0,12) : "NONE") + " convId=" + (convId ? convId.slice(0,12) : "NONE"));
  return { baseUrl, apiKey, agentId, convId };
}

/** Check if the conversation has an active run by looking at recent messages.
 *  If the last message is an approval_request or tool_call without a matching
 *  return/response, the conversation is busy. */
async function isConversationBusy(baseUrl: string, apiKey: string | undefined, convId: string, agentId?: string): Promise<boolean> {
  try {
    const checkAgentId = agentId || getApiConfig().agentId;
    if (!checkAgentId) return false;
    const resp = await fetch(
      baseUrl + "/v1/agents/" + checkAgentId + "/messages?conversation_id=" + convId + "&limit=3",
      { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} }
    );
    if (!resp.ok) return false;
    const data: any = await resp.json();
    const messages = Array.isArray(data) ? data : (data.messages || []);
    if (!messages.length) return false;

    // Check the most recent message type
    const latest = messages[0];
    const latestType = latest.message_type || "";

    // If the latest message is an approval_request, tool_call, or assistant_message
    // without a following tool_return, the conversation is likely busy
    if (latestType === "approval_request_message") return true;

    // Check if there's a pending run by looking at run_ids
    // If the latest message has a run_id different from older messages,
    // and there's no completion signal, the run might still be active
    return false;
  } catch (e) {
    return false;
  }
}

/** Try to deliver an oath via the Agent SDK (App Server websocket).
 *  This provides full tool access (Bash, Read, Edit, Write) unlike the
 *  REST API which only has server-side tools via cloud relay. */
async function tryDeliverOath(oath: Oath): Promise<{ status: "ok" | "busy" | "fail"; answer: string }> {
  const { baseUrl, apiKey, convId } = getApiConfig();
  const targetConv = (oath.conversationId && oath.conversationId !== "default") ? oath.conversationId : convId;
  if (!targetConv || targetConv === "default") return { status: "fail", answer: "No conversation ID" };

  // Check if conversation is busy before attempting delivery
  if (await isConversationBusy(baseUrl, apiKey, targetConv, oath.agentId || undefined)) {
    log("Oath " + oath.id + " delivery deferred — conversation has pending approval");
    return { status: "busy", answer: "Conversation busy (pending approval)" };
  }

  // Ensure App Server is running
  if (!isAppServerRunning()) {
    log("App Server not running — starting...");
    startAppServer();
    // Wait up to 10s for it to come up
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (isAppServerRunning()) break;
    }
    if (!isAppServerRunning()) {
      log("App Server failed to start — falling back to REST API");
      return tryDeliverOathRest(oath, targetConv);
    }
  }

  const prompt = buildDeliveryPrompt(oath);
  log("Attempting SDK delivery for " + oath.id + " to " + targetConv);

  try {
    const result = execSync(
      `node "${DELIVERY_SCRIPT}" "${targetConv}" '${prompt.replace(/'/g, "'\\''")}'`,
      { encoding: "utf8", timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const answer = result.trim();
    if (answer.length === 0) {
      log("Oath " + oath.id + " SDK delivery returned empty — conversation busy");
      return { status: "busy", answer: "No response from SDK delivery" };
    }
    log("Oath " + oath.id + " delivered via SDK, answer length: " + answer.length);
    return { status: "ok", answer };
  } catch (e: any) {
    const stderr = e.stderr ? String(e.stderr).trim() : "";
    log("SDK delivery error for " + oath.id + ": " + (stderr || e.message || e));
    // Fall back to REST API if SDK delivery fails
    log("Falling back to REST API for " + oath.id);
    return tryDeliverOathRest(oath, targetConv);
  }
}

/** REST API fallback delivery — limited tools (server-side only) */
async function tryDeliverOathRest(oath: Oath, targetConv: string): Promise<{ status: "ok" | "busy" | "fail"; answer: string }> {
  const { baseUrl, apiKey } = getApiConfig();
  const prompt = buildDeliveryPrompt(oath);
  log("Attempting REST fallback delivery for " + oath.id + " to " + targetConv);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    const resp = await fetch(baseUrl + "/v1/conversations/" + targetConv + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
      body: JSON.stringify({ input: prompt, role: "user" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (resp.status === 409 || resp.status === 429) { log("Delivery deferred (409/429)"); return { status: "busy", answer: "Conversation busy" }; }
    if (!resp.ok) { log("Delivery HTTP " + resp.status); return { status: "fail", answer: "HTTP " + resp.status }; }

    // Read SSE stream incrementally
    const reader = resp.body?.getReader();
    let answer = "", buffer = "", done = false;
    if (reader) {
      const readTimeout = setTimeout(() => { done = true; reader.cancel().catch(() => {}); }, 30_000);
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += new TextDecoder().decode(value);
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") { done = true; break; }
          try { const d = JSON.parse(data); if (d.message_type === "assistant_message" && d.content) { answer = String(d.content).slice(0, 2000); done = true; break; } } catch (e) {}
        }
      }
      clearTimeout(readTimeout);
      reader.cancel().catch(() => {});
    }
    if (answer.length === 0) {
      log("Oath " + oath.id + " REST POST accepted but no response — retrying");
      return { status: "busy", answer: "No response in stream" };
    }
    log("Oath " + oath.id + " delivered via REST, answer length: " + answer.length);
    return { status: "ok", answer };
  } catch (e) {
    log("REST delivery error for " + oath.id + ": " + e);
    return { status: "fail", answer: "Error: " + e };
  }
}

// ─── Polling ─────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let turnEventsActive = false;

/** Delivery cycle — runs on every poll regardless of mode.
 *  Handles: delivery-check, queue transition, delivery, stuck recovery, prune.
 *  Does NOT scan for new promises (turn_end or pollCycle handles that). */
async function pollDeliveryCycle() {
  const store = StateStore.load("deliveryCycle");
  const now = Date.now();

  try {
    // 1. Check if any queued/delivering oaths have already been delivered
    const { convId: checkConvId } = getApiConfig();
    if (checkConvId) {
      const checkStore = StateStore.load("delivery-check");
      let checkChanged = false;
      try {
        const { baseUrl, apiKey, agentId } = getApiConfig();
        const resp = await fetch(
          baseUrl + "/v1/agents/" + agentId + "/messages?conversation_id=" + checkConvId + "&limit=10",
          { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} }
        );
        if (resp.ok) {
          const data: any = await resp.json();
          const msgs = Array.isArray(data) ? data : (data.messages || []);
          let recentText = "";
          for (const m of msgs) {
            const mt = m.message_type || "";
            if (mt === "user_message") {
              const parts = m.content;
              const text = typeof parts === "string" ? parts
                : Array.isArray(parts) ? parts.map((x: any) => typeof x === "string" ? x : (x?.text || "")).join(" ") : "";
              recentText += " " + text;
            } else if (mt === "assistant_message") {
              const c = m.content;
              const text = typeof c === "string" ? c : "";
              recentText += " " + text;
            }
          }
          for (const oath of checkStore.oaths) {
            if (oath.status === "queued" || oath.status === "delivering") {
              const promptSnippet = oath.promise.slice(0, 40);
              if (recentText.includes("[Oath Keeper]") && recentText.includes(promptSnippet)) {
                if (recentText.includes("[Oath Delivered]")) {
                  checkStore.updateOath(oath.id, { status: "delivered", deliveryMode: "turn_end", result: recentText.slice(-500), deliveredAt: Date.now() });
                  checkChanged = true;
                  log("Oath " + oath.id + " confirmed delivered (found in conversation history)");
                } else {
                  checkStore.updateOath(oath.id, { status: "delivering" });
                  checkChanged = true;
                  log("Oath " + oath.id + " delivery prompt found in history (waiting for response)");
                }
              }
            }
          }
        }
      } catch (e) {
        log("Delivery check error: " + e);
      }
      if (checkChanged) checkStore.save();
    }

    // 2. Transition due oaths to queued
    const queueStore = StateStore.load("queue-transition");
    for (const oath of queueStore.oaths) {
      if (oath.status === "pending" && oath.dueAt <= now) {
        queueStore.updateOath(oath.id, { status: "queued" });
        log("Oath " + oath.id + " → queued");
      }
    }
    queueStore.save();

    // 3. Try to deliver one queued oath
    // turn_end { continue } is preferred (full tool access via desktop app).
    // REST API fallback only has server-side tools (no Bash/Read/Edit/Write),
    // which can cause doom loops if the agent tries to use client-side tools.
    // Use a long timeout so oaths are delivered via turn_end when possible.
    const QUEUED_TIMEOUT = 300_000; // 5 minutes before REST fallback
    let queuedOath = undefined;

    if (turnEventsActive) {
      // Check if any queued oath has been waiting too long
      const overdue = queueStore.oaths.find((o) =>
        o.status === "queued" && (now - o.dueAt) > QUEUED_TIMEOUT
      );
      if (overdue) {
        log("Oath " + overdue.id + " queued for >60s without turn_end — falling back to REST API");
        queuedOath = overdue;
      } else {
        log("Skipping REST delivery — turn_end will handle via { continue }");
      }
    } else {
      queuedOath = queueStore.oaths.find((o) => o.status === "queued");
    }
    if (queuedOath) {
      store.updateOath(queuedOath.id, { status: "delivering" });
      store.save();
      log("Oath " + queuedOath.id + " queued → delivering (locked)");

      const result = await tryDeliverOath(queuedOath);
      const updateStore = StateStore.load("delivery-result");
      const currentOath = updateStore.findOath(queuedOath.id);
      if (currentOath && currentOath.status === "delivered") {
        log("Oath " + queuedOath.id + " already delivered (history check) — skipping result update");
      } else if (result.status === "busy") {
        updateStore.updateOath(queuedOath.id, { status: "queued" });
        updateStore.save();
        log("Oath " + queuedOath.id + " back to queued (busy)");
      } else if (result.status === "ok") {
        updateStore.updateOath(queuedOath.id, { status: "delivered", deliveryMode: "sdk", result: result.answer.slice(0, 500), deliveredAt: Date.now() });
        updateStore.save();
        log("Oath " + queuedOath.id + " delivered");
      } else {
        updateStore.updateOath(queuedOath.id, { status: "failed", result: result.answer.slice(0, 500), deliveredAt: Date.now() });
        updateStore.save();
        log("Oath " + queuedOath.id + " failed: " + result.answer);
      }
    }

    // 4. Reset stuck delivering oaths (>5 min)
    const resetStore = StateStore.load("stuck-check");
    const fiveMinAgo = now - 300_000;
    for (const oath of resetStore.oaths) {
      if (oath.status === "delivering" && oath.dueAt < fiveMinAgo) {
        resetStore.updateOath(oath.id, { status: "queued" });
        log("Oath " + oath.id + " stuck → queued");
      }
    }
    // Prune llm_failed after 10 minutes (same as prefilter_rejected)
    resetStore.prune(now);
    resetStore.save();
  } catch (e) {
    log("Delivery cycle error: " + e);
  }
}

/** Full poll cycle — delivery + scanning. Only used when turn_end is NOT available. */
async function pollCycle() {
  const now = Date.now();

  try {
    // Run delivery logic first
    await pollDeliveryCycle();

    // Then scan for new promises across ALL agents' conversations
    // (turn_end may or may not fire — polling ensures channel messages are caught)
    const scanStore = StateStore.load("scan-phase");
    // Don't skip scan when there are active oaths — with multi-agent scanning,
    // one agent's active oath shouldn't block scanning other agents.
    // Per-agent lastScannedMessageIds prevents duplicate oaths.

    const { convId } = getApiConfig();
    const agentIds = await discoverAgentIds();
    for (const scanAgentId of agentIds) {
      const allMsgs = await fetchLatestAgentMessage(scanAgentId);
      const lastScanned = scanStore.getScannedForAgent(scanAgentId);
      if (!allMsgs) continue;

      // Process ALL unscanned messages (oldest first), not just the latest one
      const unscanned = lastScanned
        ? allMsgs.filter(m => m.id !== lastScanned)
        : allMsgs;

      for (const latest of unscanned) {
        if (latest.isDeliveryResponse) { log("Skipping — delivery response"); scanStore.setScannedForAgent(scanAgentId, latest.id); scanStore.save(); continue; }
        const msgConvId = latest.conversationId || convId;
        const preFilter = detectPromiseRegex(latest.text);
        if (preFilter) {
          log("Regex pre-filter matched: " + preFilter.match + " — confirming with LLM");

          // Dedup check BEFORE LLM — saves tokens and prevents duplicates when LLM is unavailable
          const alreadyScanned = scanStore.oaths.some((o) => o.sourceMessageId === latest.id) ||
                                 scanStore.hasRecentPromise(latest.text.slice(0, 300));
          if (alreadyScanned) {
            log("Skipping — already have oath for this message");
            scanStore.setScannedForAgent(scanAgentId, latest.id);
            scanStore.save();
            continue;
          }

          let confirmed: { promise: string; delayMs: number; tokens?: { prompt: number; completion: number; total: number }; error?: boolean; status?: number } | null = null;
          let llmTokens: { prompt: number; completion: number; total: number } | undefined;

          if (isLlmConfirmEnabled()) {
            confirmed = await confirmPromise(latest.text);
            if (confirmed?.error) {
              log("polling LLM: API error " + confirmed.status + " — creating oath with llm_failed status");
            } else {
              log("polling LLM: " + (confirmed ? "CONFIRMED: " + confirmed.promise.slice(0, 60) : "REJECTED"));
            }
            if (confirmed?.tokens) llmTokens = confirmed.tokens;
          } else {
            confirmed = { promise: latest.text.slice(0, 300), delayMs: DEFAULT_DELAY_MS };
            log("polling: LLM confirm disabled — creating oath directly");
          }

          if (!confirmed) {
            logFalsePositive(preFilter.match, latest.text, "polling", preFilter.score, msgConvId, scanAgentId);
          }
          if (confirmed?.error) {
            // LLM failed (402, rate limit, etc.) — create oath with llm_failed status
            const oath = createOath(latest.text.slice(0, 300), latest.userContext, msgConvId, scanAgentId, latest.id, "polling", DEFAULT_DELAY_MS);
            oath.ngramScore = preFilter.score;
            oath.status = "llm_failed";
            scanStore.addOath(oath);
            scanStore.save();
            log("polling: oath created (llm_failed) — " + oath.id + " agent=" + scanAgentId.slice(0,12) + " score=" + preFilter.score);
          } else if (confirmed && !confirmed.error) {
            const oath = createOath(confirmed.promise, latest.userContext, msgConvId, scanAgentId, latest.id, "polling", confirmed.delayMs);
            oath.ngramScore = preFilter.score;
            oath.llmTokens = llmTokens;
            scanStore.addOath(oath);
            log("polling: oath created — " + oath.id + " agent=" + scanAgentId.slice(0,12) + " conv=" + msgConvId.slice(0,12) + " score=" + preFilter.score + " delay=" + (confirmed.delayMs/1000) + "s");
          }
        }
        scanStore.setScannedForAgent(scanAgentId, latest.id);
        scanStore.save();
      }
    }
  } catch (e) {
    log("Poll error: " + e);
  }
}

// ─── Agent discovery ─────────────────────────────────────────────

let cachedAgentIds: string[] | null = null;
let agentCacheTime = 0;
const AGENT_CACHE_TTL = 300_000; // 5 minutes

async function discoverAgentIds(): Promise<string[]> {
  const now = Date.now();
  if (cachedAgentIds && (now - agentCacheTime) < AGENT_CACHE_TTL) return cachedAgentIds;
  const { baseUrl, apiKey } = getApiConfig();
  try {
    const resp = await fetch(baseUrl + "/v1/agents?limit=100", { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} });
    if (!resp.ok) { log("discoverAgentIds: HTTP " + resp.status); return cachedAgentIds || []; }
    const data: any = await resp.json();
    const agents = Array.isArray(data) ? data : (data.data || data.agents || []);
    cachedAgentIds = agents.map((a: any) => a.id).filter((id: string) => id);
    agentCacheTime = now;
    log("discoverAgentIds: found " + cachedAgentIds.length + " agents");
    return cachedAgentIds;
  } catch (e) { log("discoverAgentIds error: " + e); return cachedAgentIds || []; }
}

// ─── Message fetching ────────────────────────────────────────────

async function fetchLatestAgentMessage(scanAgentId?: string): Promise<{ id: string; text: string; userContext: string; isDeliveryResponse: boolean; conversationId?: string }[] | null> {
  const { baseUrl, apiKey, agentId: envAgentId, convId } = getApiConfig();
  const targetAgentId = scanAgentId || envAgentId;
  if (!targetAgentId) return null;
  try {
    // Fetch recent messages across ALL conversations (no conversation_id filter)
    const resp = await fetch(baseUrl + "/v1/agents/" + targetAgentId + "/messages?limit=50", { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const messages = Array.isArray(data) ? data : (data.messages || []);
    if (!messages.length) return null;
    // Sort oldest first so we can track the most recent user_message as context
    messages.sort((a: any, b: any) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime());

    const results: { id: string; text: string; userContext: string; isDeliveryResponse: boolean; conversationId?: string }[] = [];
    let lastUserContext = "(no context)";
    let lastConvId = convId;

    for (const m of messages) {
      const mt = m.message_type || "";

      // Track the most recent user_message as context (for all messages after it)
      if (mt === "user_message") {
        const c = m.content;
        let text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => typeof x === "string" ? x : (x?.text || "")).join(" ") : "";
        text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        if (text) lastUserContext = text.slice(0, 200);
        continue;
      }

      let msgText = "";
      let msgId = m.id || "";
      let msgRunId = m.run_id || "";

      // Check assistant_message for promise language
      if (mt === "assistant_message") {
        const c = m.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => typeof x === "string" ? x : (x?.text || "")).join(" ") : "";
        if (text.trim()) msgText = text;
      }
      // Check MessageChannel tool calls for promise language
      else if (mt === "approval_request_message" && m.tool_call) {
        const tc = m.tool_call;
        if (tc.name === "MessageChannel") {
          let args: any = tc.arguments;
          if (typeof args === "string") { try { args = JSON.parse(args); } catch (e) { args = {}; } }
          const channelText = args.message || "";
          if (channelText.trim() && channelText.length > 15) msgText = channelText;
        }
      }

      if (msgText.trim()) {
        // Resolve conversation ID from run
        let msgConvId = lastConvId;
        if (msgRunId) {
          try {
            const runResp = await fetch(baseUrl + "/v1/runs/" + msgRunId, { headers: apiKey ? { Authorization: "Bearer " + apiKey } : {} });
            if (runResp.ok) {
              const run: any = await runResp.json();
              if (run.conversation_id) { msgConvId = run.conversation_id; lastConvId = msgConvId; }
            }
          } catch (e) {}
        }
        results.push({
          id: msgId,
          text: msgText,
          userContext: lastUserContext,
          isDeliveryResponse: lastUserContext.includes("[Oath Keeper]"),
          conversationId: msgConvId,
        });
      }
    }
    return results.length > 0 ? results : null;
  } catch (e) { log("fetchLatestAgentMessage error: " + e); return null; }
}

// ─── Mod Activation ──────────────────────────────────────────────

export default function activate(letta: any) {
  const disposers: Array<() => void> = [];

  // Self-heal the env file on startup — discover correct port
  selfHealEnvFile();

  // Start the App Server for SDK-based delivery (full tool access)
  startAppServer();

  const hasTurnEvents = letta.capabilities.events?.turns === true;
  turnEventsActive = hasTurnEvents;
  log("Capabilities: " + JSON.stringify(letta.capabilities));
  log("hasTurnEvents: " + hasTurnEvents);
  try { letta.diagnostics.report({ message: "Capabilities: " + JSON.stringify(letta.capabilities) + " hasTurnEvents: " + hasTurnEvents, severity: "warning" }); } catch (e) {}

  if (!letta.capabilities.tools) { log("No tools — inactive"); return () => {}; }

  // ── turn_end — uses event context for conversation/agent scoping (no env file)
  if (hasTurnEvents) {
    disposers.push(
      letta.events.on("turn_end", async (event: any, ctx: any) => {
        log("turn_end FIRED");

        // Extract conversation/agent IDs from event context — NOT env file
        const eventConvId = event.conversationId || ctx?.conversation?.id || "";
        const eventAgentId = event.agentId || ctx?.agent?.id || "";
        const lastMsg = event.assistantMessage || "";

        // ── STEP 1: Check for queued oaths ready for delivery (via { continue })
        // This uses the mod event surface instead of REST API — tools work properly
        const deliverStore = StateStore.load("turn_end-deliver");
        const dueOath = deliverStore.oaths.find((o) =>
          (o.status === "queued") &&
          o.conversationId === eventConvId
        );

        if (dueOath) {
          log("turn_end: delivering oath via { continue } — " + dueOath.id);
          deliverStore.updateOath(dueOath.id, { status: "delivering", deliveryMode: "turn_end" });
          deliverStore.save();

          const prompt = buildDeliveryPrompt(dueOath);
          return { continue: prompt };
        }

        // ── STEP 2: Mark delivered oaths if the response contains [Oath Delivered]
        if (lastMsg.includes("[Oath Delivered]")) {
          const store = StateStore.load("turn_end-mark");
          for (const oath of store.oaths) {
            if (oath.status === "delivering" || oath.status === "queued") {
              store.updateOath(oath.id, { status: "delivered", deliveryMode: "turn_end", result: lastMsg.slice(0, 500), deliveredAt: Date.now() });
            }
          }
          store.save();
          return;
        }

        // Skip detection for [Oath Keeper] delivery prompts
        if (lastMsg.includes("[Oath Keeper]")) return;

        // ── STEP 3: Detect promises in the assistant message
        const msgText = event.assistantMessage || "";
        if (!msgText || !msgText.trim()) { log("turn_end: no assistant message in event"); return; }

        // Safety check: if both n-gram and LLM confirmation are disabled, don't run any filters
        if (!filtersActive()) {
          log("turn_end: all filters disabled — skipping detection");
          return;
        }

        const scanStore = StateStore.load("turn_end-detect");

        // Stage 1: N-gram pre-filter (if enabled)
        let ngramScore: number | undefined;
        if (isNgramEnabled()) {
          const preFilter = detectPromiseRegex(msgText);
          if (!preFilter) {
            const rejectScore = computeNgramScore(msgText);
            logPreFilterRejection(msgText, "ngram score <= 1.5 or negative filter", rejectScore, eventConvId, eventAgentId);
            return;
          }
          ngramScore = preFilter.score;
          log("turn_end: pre-filter passed (score=" + preFilter.score + ")");
        } else {
          ngramScore = computeNgramScore(msgText);
          log("turn_end: n-gram filter disabled (score=" + ngramScore + " — not used for filtering)");
        }

        // Stage 2: LLM confirmation (if enabled)
        let detection: { promise: string; delayMs: number; tokens?: { prompt: number; completion: number; total: number } } | null = null;
        let llmTokens: { prompt: number; completion: number; total: number } | undefined;
        if (isLlmConfirmEnabled()) {
          log("turn_end: sending to LLM...");
          detection = await confirmPromise(msgText);
          log("turn_end LLM: " + (detection ? "CONFIRMED: " + detection.promise.slice(0, 60) + " delay=" + (detection.delayMs/1000) + "s" : "REJECTED"));

          if (detection?.tokens) llmTokens = detection.tokens;

          if (!detection) {
            logFalsePositive("llm", msgText, "turn_end", ngramScore, eventConvId, eventAgentId);
            // Store tokens on the false positive entry
            if (llmTokens) {
              const fpStore = StateStore.load("turn_end-fp-tokens");
              const fpEntry = fpStore.oaths[fpStore.oaths.length - 1];
              if (fpEntry) {
                fpStore.updateOath(fpEntry.id, { llmTokens });
                fpStore.save();
              }
            }
            scanStore.save();
            return;
          }
        } else {
          // LLM confirmation disabled — create oath directly from message text
          detection = { promise: msgText.slice(0, 300), delayMs: DEFAULT_DELAY_MS };
          log("turn_end: LLM confirm disabled — creating oath directly");
        }

        // Stage 3: LLM semantic dedup (if enabled)
        if (isLlmDedupEnabled()) {
          const existing = scanStore.activeOaths();
          const dedupResult = existing.length > 0 ? await isDuplicatePromise(detection.promise, existing) : { isDup: false };
          if (dedupResult.tokens) {
            // Accumulate dedup tokens
            if (!llmTokens) llmTokens = { prompt: 0, completion: 0, total: 0 };
            llmTokens.prompt += dedupResult.tokens.prompt;
            llmTokens.completion += dedupResult.tokens.completion;
            llmTokens.total += dedupResult.tokens.total;
          }
          if (dedupResult.isDup) {
            log("turn_end: duplicate promise — skipping");
            return;
          }
        }

        // String-based dedup (always runs as fast fallback)
        const alreadyExists = scanStore.hasRecentPromise(detection.promise);
        if (!alreadyExists) {
          const oath = createOath(detection.promise, "(turn_end)", eventConvId, eventAgentId, undefined, "turn_end", detection.delayMs);
          oath.ngramScore = ngramScore;
          oath.llmTokens = llmTokens;
          scanStore.addOath(oath);
          scanStore.save();
          log("turn_end: oath created — " + oath.id + " conv=" + eventConvId.slice(0,12) + " score=" + (ngramScore ?? "N/A") + " delay=" + (detection.delayMs/1000) + "s");
        }
      })
    );
    log("turn_end handler registered");
  }

  // ── Polling — always enabled for delivery timing
  // Scanning is disabled when turn_end handles detection (avoid duplicate oaths)
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(pollCycle, POLL_INTERVAL_MS);
  pollCycle();
  log("Polling started (turn_end active: " + hasTurnEvents + ")");

  // Write filter status to file for TUI to read
  const filterStatus = {
    negativeFilter: isNegativeFilterEnabled(),
    ngram: isNgramEnabled(),
    ngramThreshold: getNgramThreshold(),
    llmConfirm: isLlmConfirmEnabled(),
    llmDedup: isLlmDedupEnabled(),
    filtersActive: filtersActive(),
    classifierAgentId: getClassifierAgentId(),
    classifierModel: "",
    timestamp: Date.now(),
  };

  // Use the configured classifier model (not the agent's model)
  filterStatus.classifierModel = getClassifierModel();

  try { fs.writeFileSync(`${HOME}/.letta/mods/oath-keeper-filter-status.json`, JSON.stringify(filterStatus, null, 2)); } catch (e) {}

  // ── list_oaths tool ─────────────────────────────────────────
  disposers.push(
    letta.tools.register({
      name: "list_oaths",
      description: "List all pending and recently delivered oaths (promises tracked by Oath Keeper).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      parallelSafe: true,
      async run() {
        const store = StateStore.load("list_oaths");
        const pending = store.oaths.filter((o) => o.status === "pending" || o.status === "queued");
        const delivering = store.oaths.filter((o) => o.status === "delivering");
        const recent = store.oaths.filter((o) => (o.status === "delivered" || o.status === "failed") && o.deliveredAt && Date.now() - o.deliveredAt < 3_600_000);
        const falsePositives = store.oaths.filter((o) => o.status === "false_positive" && o.deliveredAt && Date.now() - o.deliveredAt < 3_600_000);
        const prefiltered = store.oaths.filter((o) => o.status === "prefilter_rejected" && o.deliveredAt && Date.now() - o.deliveredAt < 3_600_000);
        if (pending.length === 0 && delivering.length === 0 && recent.length === 0 && falsePositives.length === 0 && prefiltered.length === 0) return "No oaths. Agents have kept their word.";
        const lines = [`Oath Keeper — ${pending.length} pending, ${delivering.length} delivering, ${recent.length} recent, ${falsePositives.length} false positive, ${prefiltered.length} prefiltered`];
        for (const o of [...pending, ...delivering]) {
          const secs = Math.max(0, Math.round((o.dueAt - Date.now()) / 1000));
          const score = o.ngramScore ? ` [${o.ngramScore}]` : "";
          lines.push(`${o.status.toUpperCase()} (${secs}s)${score}: "${o.promise.slice(0, 80)}"`);
        }
        for (const o of recent) lines.push(`${o.status === "delivered" ? "OK" : "FAIL"}: "${o.promise.slice(0, 80)}"`);
        for (const o of falsePositives) lines.push(`FP: "${o.promise.slice(0, 80)}"`);
        for (const o of prefiltered) lines.push(`PF: "${o.promise.slice(0, 80)}"`);
        return lines.join("\n");
      },
    })
  );

  log("list_oaths registered");

  return () => {
    for (const d of disposers.reverse()) { try { d(); } catch (e) {}
    }
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
    stopAppServer();
  };
}
