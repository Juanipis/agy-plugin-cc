import test from "node:test";
import assert from "node:assert";

import { parseArgs, splitRawArgumentString } from "../plugins/agy/scripts/lib/args.mjs";
import {
  parseStructuredOutput,
  buildPersistentTaskThreadName,
  interruptAppServerTurn,
  readOutputSchema,
  capPromptBytes,
  TASK_THREAD_PREFIX
} from "../plugins/agy/scripts/lib/agy.mjs";
import { parseStopReviewOutput } from "../plugins/agy/scripts/stop-review-gate-hook.mjs";
import { normalizeReviewResultData } from "../plugins/agy/scripts/lib/render.mjs";

test("parseArgs parses value options, booleans and positionals", () => {
  const { options, positionals } = parseArgs(
    ["--model", "Gemini 3.1 Pro", "--write", "fix", "the", "bug"],
    { valueOptions: ["model"], booleanOptions: ["write"] }
  );
  assert.strictEqual(options.model, "Gemini 3.1 Pro");
  assert.strictEqual(options.write, true);
  assert.deepStrictEqual(positionals, ["fix", "the", "bug"]);
});

test("parseArgs supports --key=value and short aliases", () => {
  const { options } = parseArgs(["--base=main", "-m", "flash"], {
    valueOptions: ["base", "model"],
    aliasMap: { m: "model" }
  });
  assert.strictEqual(options.base, "main");
  assert.strictEqual(options.model, "flash");
});

test("parseArgs throws when a value option is missing its value", () => {
  assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /Missing value for --model/);
});

test("splitRawArgumentString keeps quoted segments intact", () => {
  assert.deepStrictEqual(
    splitRawArgumentString(`review --model "Claude Sonnet 4.6 (Thinking)" now`),
    ["review", "--model", "Claude Sonnet 4.6 (Thinking)", "now"]
  );
});

test("parseStructuredOutput reads a fenced json block", () => {
  const raw = "prose\n```json\n{\"summary\":\"ok\"}\n```\ntrailing";
  const { parsed, parseError } = parseStructuredOutput(raw);
  assert.strictEqual(parseError, null);
  assert.strictEqual(parsed.summary, "ok");
});

test("parseStructuredOutput parses bare json", () => {
  const { parsed, parseError } = parseStructuredOutput('{"a":1}');
  assert.strictEqual(parseError, null);
  assert.strictEqual(parsed.a, 1);
});

test("parseStructuredOutput returns the fallback on invalid json", () => {
  const fallback = { status: "failed" };
  const { parsed, parseError } = parseStructuredOutput("not json at all", fallback);
  assert.notStrictEqual(parseError, null);
  assert.deepStrictEqual(parsed, fallback);
});

test("buildPersistentTaskThreadName is derived from the prompt", () => {
  assert.strictEqual(buildPersistentTaskThreadName(""), TASK_THREAD_PREFIX);
  assert.ok(buildPersistentTaskThreadName("refactor the db module").startsWith(TASK_THREAD_PREFIX));
});

test("interruptAppServerTurn returns a well-formed result (no crash on cancel)", async () => {
  const result = await interruptAppServerTurn("/tmp", { threadId: "x", turnId: "y" });
  assert.strictEqual(typeof result, "object");
  assert.strictEqual(result.attempted, false);
  assert.strictEqual(result.interrupted, false);
  assert.strictEqual(typeof result.detail, "string");
});

test("readOutputSchema returns null for a missing file", () => {
  assert.strictEqual(readOutputSchema("/no/such/schema.json"), null);
});

test("parseStopReviewOutput blocks on a BLOCK marker", () => {
  const result = parseStopReviewOutput("BLOCK: tests are failing");
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /tests are failing/);
});

test("parseStopReviewOutput allows on an ALLOW marker", () => {
  assert.strictEqual(parseStopReviewOutput("ALLOW: looks good").ok, true);
});

test("parseStopReviewOutput finds a BLOCK marker on a later line", () => {
  const result = parseStopReviewOutput("Here is my analysis...\nBLOCK: missing null check");
  assert.strictEqual(result.ok, false);
});

test("parseStopReviewOutput fails open on ambiguous or empty output", () => {
  assert.strictEqual(parseStopReviewOutput("the code seems fine to me").ok, true);
  assert.strictEqual(parseStopReviewOutput("").ok, true);
});

test("parseStopReviewOutput keeps the full multiline BLOCK rationale", () => {
  const result = parseStopReviewOutput("BLOCK: missing guard\n- null deref at x.mjs:10\n- no test");
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /missing guard/);
  assert.match(result.reason, /null deref at x\.mjs:10/);
  assert.match(result.reason, /no test/);
});

test("capPromptBytes leaves small prompts untouched", () => {
  const { prompt, truncated } = capPromptBytes("small prompt", 1000);
  assert.strictEqual(truncated, false);
  assert.strictEqual(prompt, "small prompt");
});

test("capPromptBytes truncates oversized prompts under the byte budget (E2BIG guard)", () => {
  const huge = "A".repeat(500_000);
  const { prompt, truncated } = capPromptBytes(huge, 120_000);
  assert.strictEqual(truncated, true);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 120_000, "must stay within the byte budget");
  assert.match(prompt, /truncated to fit the CLI argument size limit/);
});

test("review verdict fails closed on casing and approve-with-findings", () => {
  // clean approve
  assert.strictEqual(normalizeReviewResultData({ verdict: "approve", findings: [] }).verdict, "approve");
  // casing variant is not a clean approve
  assert.strictEqual(normalizeReviewResultData({ verdict: "Approve", findings: [] }).verdict, "approve");
  // approve with findings -> needs-attention
  assert.strictEqual(
    normalizeReviewResultData({ verdict: "approve", findings: [{ finding: "bug" }] }).verdict,
    "needs-attention"
  );
  // unknown phrasing -> needs-attention
  assert.strictEqual(normalizeReviewResultData({ verdict: "reject", findings: [] }).verdict, "needs-attention");
  // missing verdict, no findings -> approve
  assert.strictEqual(normalizeReviewResultData({ findings: [] }).verdict, "approve");
});

test("review findings coerce string line numbers and body aliases", () => {
  const { findings } = normalizeReviewResultData({
    findings: [{ finding: "null deref here", file: "x.mjs", line_start: "10", line_end: "12" }]
  });
  assert.strictEqual(findings[0].line_start, 10);
  assert.strictEqual(findings[0].line_end, 12);
  assert.strictEqual(findings[0].body, "null deref here");
  assert.strictEqual(findings[0].file, "x.mjs");
});
