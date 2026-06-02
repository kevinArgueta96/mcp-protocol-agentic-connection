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
import { AntigravityLsBridgeService } from "../../client/antigravity-ls-bridge-service.js";
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
  identity?: string,
): Promise<string | undefined> {
  if (clientId) return clientId;
  // When an identity namespace is set, pick the project session whose identity
  // matches — otherwise distinct tickets in the same project would be confused.
  if (identity) {
    const agents = await registry.listAgents({ project });
    const wanted = identity;
    const match = agents.find(
      (a) => a.entryType === "client" && (a.identity ?? "global") === wanted,
    );
    if (match) return match.agentId;
  }
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
    .option("--identity <id>", "Channel namespace — only sessions sharing it see each other (default: global)")
    .option("--global", "Install into ~/.gemini/antigravity-cli instead of the workspace .agents/")
    .action((options) => {
      const targetDir = options.global
        ? join(homedir(), ".gemini", "antigravity-cli")
        : join(options.project, ".agents");
      mkdirSync(targetDir, { recursive: true });

      const mcpArgs = ["mcp", "start", "--registry-url", options.registryUrl, "--project", options.project];
      if (options.identity) mcpArgs.push("--identity", options.identity);
      const mcpConfig = {
        mcpServers: {
          "agent-bridge": {
            command: options.bridgeCommand,
            args: mcpArgs,
          },
        },
      };
      writeFileSync(
        join(targetDir, "mcp_config.json"),
        `${JSON.stringify(mcpConfig, null, 2)}\n`,
        "utf8",
      );

      // NOTE: we intentionally do NOT write hooks.json. agy's hooks schema
      // (jsonhook.JSONHookSpec) differs from what we generated and failed to
      // parse, and the Stop-hook auto-arrival is superseded by `ls-push`
      // (native push into the live TUI via the Cascade Language Server).
      const idArg = options.identity ? ` --identity ${options.identity}` : "";

      console.log(chalk.green("✓") + " Antigravity MCP config installed");
      console.log(`  Target:   ${targetDir}`);
      console.log(`  Registry: ${options.registryUrl}`);
      console.log("  File:     mcp_config.json");
      console.log(
        chalk.dim(
          "\n  1. Restart `agy` in this workspace so it loads the MCP server.\n" +
            `  2. For automatic delivery into the live TUI, run the push daemon:\n` +
            `       open-agent-bridge antigravity ls-push --project "${options.project}"${idArg}`,
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
    .option("--identity <id>", "Channel namespace to resolve the session for (default: global)")
    .action(async (options) => {
      await readStdin(); // consume the hook event payload (unused for now)
      try {
        const registry = new RegistryClient(options.registryUrl);
        const clientId = await resolveClientId(registry, options.project, options.clientId, options.identity);
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
    .option("--identity <id>", "Channel namespace to resolve the session for (default: global)")
    .action(async (options) => {
      await readStdin();
      try {
        const registry = new RegistryClient(options.registryUrl);
        const clientId = await resolveClientId(registry, options.project, options.clientId, options.identity);
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

  // ── antigravity ls-push ──────────────────────────────────────────────────────
  antigravity
    .command("ls-push")
    .description(
      "Auto-deliver channel messages into a LIVE agy TUI via its Cascade Language " +
        "Server (SendUserCascadeMessage) — no tmux, no manual 'check inbox'. Requires " +
        "agy running with an open conversation in the workspace.",
    )
    .option("--project <path>", "Workspace path", process.cwd())
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--identity <id>", "Channel namespace of the agy session (default: global)")
    .option("--client-id <id>", "Explicit Antigravity client session ID")
    .option("--poll-interval-ms <n>", "Polling interval in ms", "2000")
    .option("--retry-interval-ms <n>", "Re-injection blackout per message in ms", "30000")
    .option("--once", "Run a single poll cycle and exit")
    .option("--verbose", "Verbose logs")
    .action(async (options) => {
      const service = new AntigravityLsBridgeService({
        projectPath: options.project,
        registryUrl: options.registryUrl,
        identity: options.identity,
        clientId: options.clientId,
        pollIntervalMs: Number(options.pollIntervalMs),
        retryIntervalMs: Number(options.retryIntervalMs),
        verbose: options.verbose ?? true,
      });
      if (options.once) {
        const n = await service.runOnce();
        console.error(`[antigravity ls-push] injected ${n} message(s)`);
        return;
      }
      console.error(
        chalk.green("✓") +
          ` Antigravity ls-push running (project: ${options.project}, identity: ${options.identity ?? "global"}). Ctrl-C to stop.`,
      );
      await service.start();
    });
}
