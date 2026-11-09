import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { binaryAvailable } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
export const TASK_THREAD_PREFIX = "Agy Companion Task";

const DEFAULT_PRINT_TIMEOUT = "10m0s";
// agy has no stdin/prompt-file input, so prompts go through argv. Linux caps a
// single argv string at ~128KB (MAX_ARG_STRLEN); stay well under it so large
// diffs can't trigger E2BIG. Instructions are placed first in every prompt, so
// truncating the tail drops only the end of the embedded diff.
const MAX_PROMPT_BYTES = 120_000;
const PROMPT_TRUNCATION_MARKER =
  "\n\n[... content truncated to fit the CLI argument size limit; review the remainder separately ...]";

export function capPromptBytes(prompt, maxBytes = MAX_PROMPT_BYTES) {
  const text = String(prompt ?? "");
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { prompt: text, truncated: false };
  }
  const markerBytes = Buffer.byteLength(PROMPT_TRUNCATION_MARKER, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  // subarray on a byte boundary may split a multibyte char; toString replaces the
  // trailing partial byte with U+FFFD, which is harmless inside a diff.
  const head = buffer.subarray(0, budget).toString("utf8");
  return { prompt: head + PROMPT_TRUNCATION_MARKER, truncated: true };
}
const GEMINI_HOME = path.join(os.homedir(), ".gemini");
const LAST_CONVERSATIONS_FILE = path.join(
  GEMINI_HOME,
  "antigravity-cli",
  "cache",
  "last_conversations.json"
);
const OAUTH_CREDS_FILE = path.join(GEMINI_HOME, "oauth_creds.json");

export function getAgyAvailability(cwd) {
  return binaryAvailable("agy", ["--help"], { cwd });
}

export function getSessionRuntimeStatus() {
  return { available: true, version: "CLI-only", label: "agy CLI (direct)" };
}

/**
 * Agy stores the most recent conversation id per workspace directory in
 * ~/.gemini/antigravity-cli/cache/last_conversations.json (keyed by absolute path).
 * We read it back after a run to recover the real conversation id, since `agy -p`
 * only prints the model response.
 */
function resolveConversationKey(cwd) {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function readLatestConversationId(cwd) {
  let map;
  try {
    map = JSON.parse(fs.readFileSync(LAST_CONVERSATIONS_FILE, "utf8"));
  } catch {
    return null;
  }
  if (!map || typeof map !== "object") {
    return null;
  }
  const resolved = resolveConversationKey(cwd);
  if (map[resolved]) {
    return map[resolved];
  }
  const literal = path.resolve(cwd);
  return map[literal] ?? null;
}

export async function getAgyAuthStatus(cwd) {
  const avail = getAgyAvailability(cwd);
  if (!avail.available) {
    return {
      available: false,
      loggedIn: false,
      detail: "Agy CLI not found on PATH.",
      source: "local",
      authMethod: "google",
      verified: false,
      provider: "google"
    };
  }

  let loggedIn = false;
  try {
    loggedIn = fs.readFileSync(OAUTH_CREDS_FILE, "utf8").trim().length > 0;
  } catch {
    loggedIn = false;
  }

  return {
    available: true,
    loggedIn,
    detail: loggedIn
      ? "Authenticated with Google (found ~/.gemini/oauth_creds.json)."
      : "No Google credentials found. Run `agy` once interactively to sign in.",
    source: "local",
    authMethod: "google",
    verified: loggedIn,
    provider: "google"
  };
}

/**
 * Agy has no server/turn-interrupt API, so cancellation is handled by terminating
 * the local process tree in the companion. This returns a well-formed result so
 * callers can render cancel status without crashing.
 */
export async function interruptAppServerTurn() {
  return {
    attempted: false,
    interrupted: false,
    detail: "Agy CLI has no turn-interrupt API; cancellation stops the local process instead."
  };
}

export function findLatestTaskThread(cwd) {
  const id = readLatestConversationId(cwd);
  return id ? { id } : null;
}

export function buildPersistentTaskThreadName(prompt) {
  const normalized = String(prompt ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return TASK_THREAD_PREFIX;
  }
  return `${TASK_THREAD_PREFIX}: ${normalized.slice(0, 60)}`;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  const text = typeof rawOutput === "string" ? rawOutput : "";
  const fenced = text.match(/```json\s*\n([\s\S]*?)\n```/i)?.[1];
  const candidate = fenced ?? text;
  try {
    return { parsed: JSON.parse(candidate), rawOutput: text, parseError: null };
  } catch (err) {
    return { parsed: fallback, rawOutput: text, parseError: err.message };
  }
}

export function readOutputSchema(schemaPath) {
  try {
    return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return null;
  }
}

function describeReviewTarget(target) {
  if (target?.type === "baseBranch" && target.branch) {
    return `the changes on the current branch compared to base branch "${target.branch}"`;
  }
  return "the uncommitted changes in this repository";
}

function buildReviewPrompt(options = {}) {
  const scope = describeReviewTarget(options.target);
  const lines = [
    "You are performing a READ-ONLY code review. Do not modify, create, or delete any files.",
    `Review scope: ${scope}.`,
    "Identify correctness bugs, edge cases, security issues, and design problems.",
    "Be concise and specific, referencing file:line where possible. If nothing is wrong, say so briefly."
  ];
  if (options.content && options.content.trim()) {
    lines.push("", "Here is the diff / context to review:", "", options.content.trim());
  }
  return lines.join("\n");
}

/**
 * Sandbox mapping for the real agy CLI. `--sandbox` (terminal restrictions) is
 * applied in BOTH modes so autonomous runs can't shell out to arbitrary/dangerous
 * commands; auto-approve keeps `-p` (non-interactive) from hanging on a prompt.
 * - read-only: --sandbox only (no edit mode).
 * - workspace-write: --sandbox plus --mode accept-edits so file edits are allowed.
 */
function applySandboxArgs(args, sandbox) {
  args.push("--sandbox");
  if (sandbox === "workspace-write") {
    args.push("--mode", "accept-edits");
  }
  args.push("--dangerously-skip-permissions");
}

export async function runAppServerReview(cwd, options = {}) {
  const { prompt, truncated } = capPromptBytes(buildReviewPrompt(options));
  if (truncated && options.onProgress) {
    options.onProgress({
      message: "Diff exceeded the CLI argument limit; truncated the review input.",
      phase: "running"
    });
  }
  const args = ["-p", prompt, "--sandbox", "--dangerously-skip-permissions"];
  if (options.model) {
    args.push("--model", options.model);
  }
  args.push("--print-timeout", options.printTimeout || DEFAULT_PRINT_TIMEOUT);
  return runAgyCommand(cwd, args, options.onProgress);
}

export async function runAppServerTurn(cwd, options = {}) {
  const args = [];

  if (options.resumeThreadId) {
    args.push("--conversation", options.resumeThreadId);
  } else if (options.resumeLast) {
    args.push("--continue");
  }

  const { prompt, truncated } = capPromptBytes(options.prompt || options.defaultPrompt || "");
  if (truncated && options.onProgress) {
    options.onProgress({
      message: "Prompt exceeded the CLI argument limit; truncated the input.",
      phase: "running"
    });
  }
  if (prompt) {
    args.push("-p", prompt);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  applySandboxArgs(args, options.sandbox);
  args.push("--print-timeout", options.printTimeout || DEFAULT_PRINT_TIMEOUT);

  return runAgyCommand(cwd, args, options.onProgress);
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function buildTranscriptDigest(sourcePath, maxChars = 12000) {
  const raw = fs.readFileSync(sourcePath, "utf8");
  const parts = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message ?? entry;
    const role = message.role ?? entry.type;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractMessageText(message.content ?? message.text);
    if (text) {
      parts.push(`## ${role}\n${text}`);
    }
  }
  let digest = parts.join("\n\n");
  if (digest.length > maxChars) {
    digest = `...(earlier context truncated)...\n\n${digest.slice(digest.length - maxChars)}`;
  }
  return digest || "(No readable messages were found in the Claude transcript.)";
}

/**
 * Real transfer: seed a fresh agy conversation with a digest of the Claude
 * transcript, then recover the real conversation id agy assigns to this workspace.
 */
export async function importExternalAgentSession(cwd, options = {}) {
  const digest = buildTranscriptDigest(options.sourcePath);
  const prompt = [
    "The text below is a digest of a Claude Code session. Load it as context so we can continue the work here in Agy.",
    "",
    digest,
    "",
    "Acknowledge that you have the context and summarize the current state in 2-3 sentences. Do not modify files yet."
  ].join("\n");

  const result = await runAgyCommand(
    cwd,
    ["-p", prompt, "--sandbox", "--dangerously-skip-permissions", "--print-timeout", DEFAULT_PRINT_TIMEOUT],
    options.onProgress
  );

  return {
    threadId: result.threadId,
    status: result.exitCode ?? (result.status === "completed" ? 0 : 1),
    summary: result.finalMessage,
    stderr: result.stderr
  };
}

function buildFailureResult(previousId, message) {
  return {
    status: "failed",
    exitCode: 1,
    threadId: previousId ?? null,
    sourceThreadId: previousId ?? null,
    turnId: null,
    finalMessage: "",
    reviewText: "",
    stderr: message,
    error: { message },
    reasoningSummary: [],
    touchedFiles: []
  };
}

function runAgyCommand(cwd, args, onProgress) {
  return new Promise((resolve) => {
    const previousId = readLatestConversationId(cwd);
    // agy does not treat the process cwd as its workspace automatically; without
    // --add-dir it falls back to its scratch dir, so file reads/writes never touch
    // the user's repo and conversation IDs key off the wrong path. Pin it here.
    const fullArgs = ["--add-dir", cwd, ...args];
    if (onProgress) {
      onProgress({ message: `Running agy ${fullArgs.join(" ")}`, phase: "running" });
    }

    let child;
    try {
      child = spawn("agy", fullArgs, { cwd });
    } catch (err) {
      resolve(buildFailureResult(previousId, `Failed to launch agy: ${err.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    child.stdout?.on("data", (data) => {
      const str = data.toString();
      stdout += str;
      if (onProgress) {
        onProgress({ message: str.slice(0, 100).replace(/\n/g, " "), phase: "running", logBody: str });
      }
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      settle(buildFailureResult(previousId, `Failed to launch agy: ${err.message}${stderr ? `\n${stderr}` : ""}`));
    });

    child.on("close", (code) => {
      const threadId = readLatestConversationId(cwd) ?? previousId ?? null;
      settle({
        status: code === 0 ? "completed" : "failed",
        exitCode: code,
        threadId,
        sourceThreadId: previousId ?? null,
        turnId: null,
        finalMessage: stdout,
        reviewText: stdout,
        stderr,
        error: code === 0 ? null : { message: stderr.trim() || `agy exited with code ${code}` },
        reasoningSummary: [],
        touchedFiles: []
      });
    });
  });
}
