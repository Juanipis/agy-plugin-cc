# Changelog

## 1.0.7

- Real Agy CLI integration: recover actual per-workspace conversation IDs from
  Agy's cache (powers status, result, resume, and transfer).
- Pin the workspace with `--add-dir <cwd>` so `/agy:rescue --write` actually
  edits the repo instead of Agy's scratch directory.
- Map sandbox to real flags (`--sandbox` for read-only and write; `--mode
  accept-edits` for writes) so autonomous runs can't shell out freely.
- Cap prompts at ~120 KB to avoid `E2BIG` crashes on large diffs.
- Fix `/agy:cancel` crash and correct job status reporting.
- Real Google-OAuth auth detection in `/agy:setup`.
- Tolerant, schema-drift-resistant rendering for `/agy:adversarial-review`.
- Tolerant, fail-open stop-review gate that preserves multiline BLOCK reasons.
- Remove dead app-server/broker code and Codex-era leftovers; add a real test
  suite (19 tests) and simplified CI.

## 1.0.0

- Initial version of the Agy plugin for Claude Code
