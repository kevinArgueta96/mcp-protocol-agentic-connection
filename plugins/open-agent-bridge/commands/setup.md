---
description: Check that open-agent-bridge is installed, the registry is up, and this session is registered
argument-hint: '[--identity <name>]'
allowed-tools: Bash(open-agent-bridge:*), Bash(oab:*), Bash(npm:*), AskUserQuestion
---

Diagnose the open-agent-bridge setup for this machine and report what the user must fix.

Raw slash-command arguments: `$ARGUMENTS`

Run these checks in order and report a short checklist (✓ / ✗ per line). Do not
fix anything before reporting, except where a step says you may offer.

1. **CLI present** — run `open-agent-bridge --version`.
   - If the command is not found, the plugin's MCP server cannot start either,
     because it invokes the same binary. Tell the user to install it with
     `npm install -g open-agent-bridge` and stop; nothing else will work.

2. **Registry running** — run `open-agent-bridge status`.
   - If it is down, offer (via AskUserQuestion) to start it with
     `open-agent-bridge up`. It is a background daemon; no terminal stays busy.

3. **Peers visible** — run `open-agent-bridge list`.
   - Report how many sessions are registered and their identities.
   - A session only sees peers that share its channel identity. If the user
     passed `--identity <name>`, point out any peer NOT on that identity, since
     those are invisible to each other by design.

4. **This session registered** — check whether `open-agent-bridge list` includes
   an entry whose path matches the current working directory.
   - If it is missing, the MCP server in this session has not connected. Tell the
     user to restart the session so the plugin's MCP server starts.

Close with the single most important next action, or "Everything is ready." when
all four checks pass.
