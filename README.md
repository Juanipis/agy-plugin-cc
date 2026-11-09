# Agy Plugin for Claude Code

This plugin integrates the [Google Antigravity CLI (agy)](https://antigravity.google) directly into [Claude Code](https://github.com/anthropics/claude-code), allowing you to seamlessly delegate tasks, perform code reviews, and execute background jobs using Agy models. 

This project is deeply inspired by and based on the [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) from OpenAI, swapping out the Codex engine for Google Antigravity.

## What You Get

- **`/agy:review`**: Request Agy to review your uncommitted changes or branch diffs.
- **`/agy:adversarial-review`**: Request a highly critical, adversarial review from Agy.
- **`/agy:rescue`**: Delegate a complex task to an autonomous Agy subagent.
- **`/agy:transfer`**: Transfer the current Claude Code context to an Agy session.
- **Background Jobs**: Execute long-running Agy tasks in the background with `/agy:status`, `/agy:result`, and `/agy:cancel`.

## Requirements

1. **Antigravity CLI**: You must have `agy` installed and in your `PATH`.
   - Install via `curl -fsSL https://antigravity.google/cli/install.sh | bash`
2. **Authentication**: Your local `agy` installation must be authenticated with your Google account.
3. **Claude Code**: The official Claude Code CLI installed globally.

## Install

Add the plugin to your Claude Code workspace:

```bash
/plugin marketplace add juanipis/agy-plugin-cc
/plugin install agy@agy-marketplace
/reload-plugins
/agy:setup
```

## Usage

### `/agy:review`
Runs `agy -p` with a review prompt against your local Git state. 
- Usage: `/agy:review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]`
- Note: This is read-only and will not automatically apply patches.

### `/agy:adversarial-review`
Same as the standard review, but instructs Agy to actively look for logical flaws, edge cases, and design anti-patterns.
- Usage: `/agy:adversarial-review [--wait|--background] [--base <ref>] [focus text]`

### `/agy:rescue`
Delegates a task to the `agy:agy-rescue` subagent. It will run Agy using the specified prompt, and you can let it run in the background.
- Usage: `/agy:rescue [--background] [--wait] [--resume|--fresh] [--model <model>] [prompt]`

### `/agy:transfer`
Exports your current Claude Code transcript and provides instructions on how to continue the session using `agy --continue` or `agy --conversation <id>`.
- Usage: `/agy:transfer`

### `/agy:status`
Lists all background jobs launched by the plugin, so you can track if Agy is still working.
- Usage: `/agy:status`

### `/agy:result`
Fetches and returns the final output of a completed background job, as well as the conversation ID for resuming.
- Usage: `/agy:result [job-id]`

### `/agy:cancel`
Cancels a running Agy background job.
- Usage: `/agy:cancel [job-id]`

### `/agy:setup`
Validates that `agy` is installed, authenticated, and ready to use. Also lets you toggle the stop-review gate.
- Usage: `/agy:setup [--enable-review-gate | --disable-review-gate]`

## Typical Flows

**1. Background Delegation**
When you encounter a tedious refactoring task, you can offload it:
```
/agy:rescue --background Please refactor the database module to use connection pooling.
```
Then continue working in Claude Code. Check `/agy:status` to see when it finishes, and `/agy:result` to retrieve the output.

**2. Stop Gate Review**
If you configured `/agy:setup --enable-review-gate`, attempting to `/stop` Claude Code will automatically trigger a brief Agy review to ensure you aren't leaving any broken tests or obvious bugs behind before wrapping up.

## Agy Integration

This plugin acts as a direct wrapper over your local `agy` binary. It respects your global settings in `~/.gemini/GEMINI.md` and your workspace instructions in `AGENTS.md`.

Models can be overridden per command using the `--model` flag. Run `agy models` to list the exact names your account supports (e.g., `--model "Gemini 3.1 Pro (High)"` or `--model "Claude Sonnet 4.6 (Thinking)"`).

## FAQ

**Q: Can I use this without the `agy` CLI installed?**
No. This plugin is purely a wrapper. The intelligence and execution happen via your local `agy` installation.

**Q: Why isn't Agy applying the changes?**
`/agy:review` and `/agy:adversarial-review` run Agy with `--sandbox` and feed the diff in the prompt, so they don't edit your files. For `/agy:rescue`, you must explicitly pass `--write` if you want Agy to edit files directly; without it the task also runs sandboxed.

---

### Implementation Notes & Differences from Codex

This plugin follows the `codex-plugin-cc` architecture, but adapts it to the realities of the `agy` CLI:

1. **No App-Server / Broker**: The original Codex plugin implements a JSON-RPC broker over IPC to stream turns from the Codex backend. `agy` has no such server, so this plugin has no broker at all — the turn runners spawn `agy` directly via `child_process.spawn("agy", [...])`.
2. **Real conversation IDs**: `agy -p` prints only the model's response, so the wrapper reads the conversation ID that `agy` records per-workspace in `~/.gemini/antigravity-cli/cache/last_conversations.json` after each run. That real ID powers `/agy:status`, `/agy:result`, resume (`--conversation <id>`), and `/agy:transfer`.
3. **Sandbox mapping**: Reviews and read-only tasks run with `--sandbox --dangerously-skip-permissions` (sandboxed, and non-interactive so `-p` never hangs on a permission prompt). Write tasks (`--write`) run with `--mode accept-edits --dangerously-skip-permissions` instead.
4. **Review Gate Hook**: Uses Agy's plain CLI output, scanning it for an `ALLOW:`/`BLOCK:` marker. If no marker is found it fails open (allows the stop) rather than trapping the session.
5. **Session Transfer**: `agy` has no context-import RPC, so `/agy:transfer` builds a digest of the Claude `.jsonl` transcript, seeds a new Agy conversation with it, and returns the real `agy --conversation <id>` command to continue.

## Known Limitations

- **Concurrent background jobs in the same workspace.** The plugin recovers each run's real conversation ID by reading `~/.gemini/antigravity-cli/cache/last_conversations.json`, which Agy keys by workspace directory. If you launch two `--background` jobs in the *same* repository at the same time, whichever `agy` process finishes first may be attributed the other's conversation ID, which can confuse `/agy:status`, `/agy:result`, and resume for those jobs. Running background jobs one at a time per workspace (or in different workspaces) avoids this. Foreground runs are unaffected.
- **Large diffs are truncated, not chunked.** A single `agy` prompt is capped at ~120 KB to stay under the OS argument-size limit, so reviews of very large diffs drop the tail of the diff (with a visible marker) rather than splitting it across multiple calls.

## Contributing

Issues and pull requests are welcome. The test suite runs with `npm test` (Node's built-in test runner, no dependencies required).

## License

Licensed under the [Apache License 2.0](./LICENSE).

This project is a derivative of [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) by OpenAI (also Apache-2.0), adapted to drive the Google Antigravity CLI (`agy`). Original and derivative attributions are preserved in [`NOTICE`](./NOTICE).

---

Made by [Juanipis](https://github.com/Juanipis) · [juanipis.xyz](https://juanipis.xyz)
