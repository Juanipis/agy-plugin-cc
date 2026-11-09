---
description: Check whether the local Agy CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json $ARGUMENTS
```

Output rules:

- Present the final setup output to the user.
- If the report says Agy is not installed, tell the user to install the Agy CLI with:
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`
  then reopen their shell and rerun `/agy:setup`. Do not attempt to install it yourself.
- If Agy is installed but not authenticated, tell the user to run `agy` once interactively and complete the Google sign-in, then rerun `/agy:setup`.
