import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { appendOriginalRequest } from "../../client/antigravity-agents-file.js";
import {
  buildSessionStartHookOutput,
  buildStopHookOutput,
} from "../../client/antigravity-hooks.js";
import { collectPendingForClient } from "../../client/antigravity-pending.js";
import { RegistryClient } from "../../client/registry-client.js";

/** Read all of stdin (hook event payload). Resolves "" if nothing is piped. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Emit the hook result as JSON on stdout (Antigravity parses stdout as JSON). */
function emitHookOutput(output: unknown): void {
  process.stdout.write(JSON.stringify(output));
}

async function resolveClientId(
  registry: RegistryClient,
  project: string,
  clientId?: string,
): Promise<string | undefined> {
  if (clientId) return clientId;
  const session = await registry.findClientSession({ project });
  return session?.agentId;
}

export function registerAntigravityCommand(program: Command): void {
  const antigravity = program
    .command("antigravity")
    .description("Antigravity CLI (`agy`) integration: native channels via MCP + hooks");

  // ── antigravity install-plugin ───────────────────────────────────────────────
  antigravity
    .command("install-plugin")
    .description(
      "Write the open-agent-bridge MCP config + lifecycle hooks so `agy` delivers " +
        "channel messages automatically (Stop hook auto-continue).",
    )
    .option("--project <path>", "Workspace to install into", process.cwd())
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--bridge-command <cmd>", "open-agent-bridge executable", "open-agent-bridge")
    .option("--global", "Install into ~/.gemini/antigravity-cli instead of the workspace .agents/")
    .action((options) => {
      const targetDir = options.global
        ? join(homedir(), ".gemini", "antigravity-cli")
        : join(options.project, ".agents");
      mkdirSync(targetDir, { recursive: true });

      const mcpConfig = {
        mcpServers: {
          "agent-bridge": {
            command: options.bridgeCommand,
            args: ["mcp", "--registry-url", options.registryUrl],
          },
        },
      };
      writeFileSync(
        join(targetDir, "mcp_config.json"),
        `${JSON.stringify(mcpConfig, null, 2)}\n`,
        "utf8",
      );

      const hookCmd = (sub: string) =>
        `${options.bridgeCommand} antigravity ${sub} --project "${options.project}" --registry-url ${options.registryUrl}`;
      const hooksConfig = {
        Stop: [{ handlers: [{ type: "command", command: hookCmd("hook-stop") }] }],
        SessionStart: [{ handlers: [{ type: "command", command: hookCmd("hook-session-start") }] }],
      };
      writeFileSync(
        join(targetDir, "hooks.json"),
        `${JSON.stringify(hooksConfig, null, 2)}\n`,
        "utf8",
      );

      console.log(chalk.green("✓") + " Antigravity plugin installed");
      console.log(`  Target:   ${targetDir}`);
      console.log(`  Registry: ${options.registryUrl}`);
      console.log("  Files:    mcp_config.json, hooks.json");
      console.log(
        chalk.dim(
          "\n  Restart `agy` in this workspace so it loads the MCP server and hooks.",
        ),
      );
    });

  // ── antigravity hook-stop ────────────────────────────────────────────────────
  antigravity
    .command("hook-stop")
    .description("Stop hook: deliver pending channel messages and force agy to continue")
    .option("--project <path>", "Workspace path", process.cwd())
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--client-id <id>", "Explicit Antigravity client session ID")
    .action(async (options) => {
      await readStdin(); // consume the hook event payload (unused for now)
      try {
        const registry = new RegistryClient(options.registryUrl);
        const clientId = await resolveClientId(registry, options.project, options.clientId);
        if (!clientId) {
          emitHookOutput({});
          return;
        }

        const pending = await collectPendingForClient(registry, clientId);
        for (const msg of pending) {
          appendOriginalRequest(options.project, {
            messageId: msg.messageId,
            fromAgentId: msg.fromAgentId,
            fromAgentName: msg.fromAgentName,
            conversationId: msg.conversationId,
            content: msg.content,
            timestampIso: new Date().toISOString(),
          });
        }

        emitHookOutput(buildStopHookOutput(pending));
      } catch (err) {
        console.error("[antigravity hook-stop]", err instanceof Error ? err.message : err);
        emitHookOutput({}); // never block the agent on a bridge error
      }
    });

  // ── antigravity hook-session-start ───────────────────────────────────────────
  antigravity
    .command("hook-session-start")
    .description("SessionStart hook: surface pending channel messages as context")
    .option("--project <path>", "Workspace path", process.cwd())
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--client-id <id>", "Explicit Antigravity client session ID")
    .action(async (options) => {
      await readStdin();
      try {
        const registry = new RegistryClient(options.registryUrl);
        const clientId = await resolveClientId(registry, options.project, options.clientId);
        if (!clientId) {
          emitHookOutput({});
          return;
        }
        const pending = await collectPendingForClient(registry, clientId);
        emitHookOutput(buildSessionStartHookOutput(pending.length));
      } catch (err) {
        console.error("[antigravity hook-session-start]", err instanceof Error ? err.message : err);
        emitHookOutput({});
      }
    });
}
