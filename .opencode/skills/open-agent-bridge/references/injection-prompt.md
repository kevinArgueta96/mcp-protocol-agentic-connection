# Injection Prompt Contract

When a bridge daemon (Codex, Gemini) or the OpenCode plugin delivers an inbound channel message to a client session, it wraps the content in a structured prompt. This contract is locked by `src/__tests__/injection-prompt.test.ts`.

## Reply-required format

```
[open-agent-bridge] Channel message — reply required
===============================================
From:          <sender name> (<8-char agentId suffix>)
Conversation:  <conversationId>
Message ID:    <messageId>

----- BEGIN MESSAGE -----
<original message content>
----- END MESSAGE -----

▶ Respond to the sender NOW with the agent-bridge MCP. The sender is
  waiting on this turn — silence will block them.

Tool call (copy each field verbatim — the adapter handles routing):

  agent-bridge.reply
    agentId:        "<fromAgentId>"
    conversationId: "<conversationId>"
    replyTo:        "<messageId>"
    message:        "<your answer here>"

How to compose the reply:
  1. Do any local work the sender's message implies ...
  2. Put your answer or finding in the `message` field.
  ...
```

## Informational (no-reply) format

When `expectsResponse` resolves to `false`:

```
[open-agent-bridge] Channel message — informational (no reply)
===============================================
From:          <sender name> (<suffix>)
Conversation:  <conversationId>
Message ID:    <messageId>

----- BEGIN MESSAGE -----
<original message content>
----- END MESSAGE -----

This message does not require a reply. Do NOT call agent-bridge.reply for
this message. Process it as informational context only.
```

## Rules for receiving agents

- The IDs in the tool call template (`agentId`, `conversationId`, `replyTo`) are literal — copy them verbatim.
- Do not derive or reconstruct the IDs. The adapter handles routing, including Codex/Gemini inner-to-bridge redirect.
- For reply-required messages: call `reply` after completing any work the message implies.
- For informational messages: do NOT call `reply`. Process the content as context.

## Why this structure exists

- The `BEGIN MESSAGE / END MESSAGE` delimiters prevent prompt injection via message content.
- Literal IDs in the tool call template eliminate lookup errors.
- The `replyTo` field ensures the response threads correctly to the specific message.
- The header wording (`reply required` vs `informational`) lets the receiving LLM make a binary decision without reasoning about `expectsResponse` semantics.

## Claude Code exception

Claude Code does NOT receive the injection wrapper. It receives the raw `<channel>` push event:

```xml
<channel source="open-agent-bridge"
         from_agent="<agentId>"
         agent_name="<name>"
         conversation_id="<conversationId>"
         message_id="<messageId>"
         kind="chat">
  <message content>
</channel>
```

Claude Code decides whether to reply based on conversation context and the `expectsResponse` field surfaced in the `<channel>` tag attributes.

## Source file

Implementation: `src/client/injection-prompt.ts`
Test contract: `src/__tests__/injection-prompt.test.ts`

Do not edit the BEGIN/END markers, header wording, or ID field names without updating the test.
