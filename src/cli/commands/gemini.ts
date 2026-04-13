import type { Command } from "commander";
import chalk from "chalk";
import { GeminiTmuxBridgeService } from "../../client/gemini-tmux-bridge-service.js";
import { GeminiAcpBridge } from "../../client/gemini-acp-bridge.js";
import { detectCurrentTmuxBinding } from "../../client/codex-tmux.js";
import { readCurrentGeminiSession, writeCurrentGeminiSession } from "../../client/gemini-session-files.js";
import { RegistryServer } from "../../registry/server.js";
import { RegistryClient } from "../../client/registry-client.js";

export function registerGeminiCommand(program: Command): void {
  const gemini = program.command("gemini").description("Gemini CLI-specific utilities");

  gemini
    .command("tmux-bind")
    .description("Bind the current Gemini client session to a tmux pane so agent-bridge can inject follow-up prompts")
    .option("--project <path>", "Project path override", process.cwd())
    .option("--client-id <id>", "Exact Gemini client session ID to bind")
    .option("--pane <pane>", "Explicit tmux pane target, for example %12")
    .action(async (options) => {
      const binding = await detectCurrentTmuxBinding(options.pane);
      if (!binding?.pane) {
        console.error(chalk.red("No tmux pane detected. Run this inside tmux or pass --pane explicitly."));
        process.exit(1);
      }

      const current = readCurrentGeminiSession(options.project);
      const clientAgentId = options.clientId ?? current?.clientAgentId;
      if (!clientAgentId) {
        console.error(chalk.red("No Gemini client session marker found. Start Gemini first or pass --client-id."));
        process.exit(1);
      }

      writeCurrentGeminiSession(options.project, {
        clientAgentId,
        clientName: current?.clientName ?? "gemini",
        projectPath: options.project,
        registeredAt: current?.registeredAt ?? Date.now(),
        sidecarPid: current?.sidecarPid,
        tmuxPane: binding.pane,
        tmuxSessionName: binding.sessionName,
        tmuxWindowName: binding.windowName,
        tmuxCurrentCommand: binding.currentCommand,
      });

      console.log(chalk.green("✓") + " Gemini tmux binding updated");
      console.log(`  Client: ${clientAgentId}`);
      console.log(`  Pane: ${binding.pane}`);
      if (binding.sessionName) console.log(`  Session: ${binding.sessionName}`);
      if (binding.windowName) console.log(`  Window: ${binding.windowName}`);
      if (binding.currentCommand) console.log(`  Command: ${binding.currentCommand}`);
    });

  gemini
    .command("tmux-sidecar")
    .description("Run a per-session tmux sidecar that injects pending channel follow-ups into the active Gemini pane")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--project <path>", "Project path override", process.cwd())
    .option("--client-id <id>", "Exact Gemini client session ID to control")
    .option("--tmux-pane <pane>", "Explicit tmux pane target, for example %12")
    .option("--poll-interval-ms <number>", "Polling interval in milliseconds", "2000")
    .option("--retry-interval-ms <number>", "Retry interval for the same pending message", "30000")
    .option("--verbose", "Enable verbose sidecar logs")
    .option("--once", "Run one poll cycle and exit")
    .action(async (options) => {
      const service = new GeminiTmuxBridgeService({
        projectPath: options.project,
        registryUrl: options.registryUrl,
        clientId: options.clientId,
        tmuxPane: options.tmuxPane,
        pollIntervalMs: Number(options.pollIntervalMs),
        retryIntervalMs: Number(options.retryIntervalMs),
        verbose: options.verbose === true,
      });

      if (options.once) {
        const pending = await service.runOnce();
        console.log(chalk.cyan(`[Gemini Tmux Sidecar] scanned ${pending.length} pending conversation(s)`));
        return;
      }

      console.log(chalk.green("✓") + " Gemini tmux sidecar running");
      console.log(`  Project: ${options.project}`);
      console.log(`  Client: ${options.clientId ?? "(auto)"}`);
      console.log(`  Pane: ${options.tmuxPane ?? "(marker/auto)"}`);
      console.log(`  Registry: ${options.registryUrl}`);
      console.log(`  Poll: ${options.pollIntervalMs}ms`);
      console.log(`  Retry: ${options.retryIntervalMs}ms`);

      await service.start();

      process.on("SIGINT", () => {
        service.stop();
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        service.stop();
        process.exit(0);
      });
    });

  // ── gemini app-bridge ──────────────────────────────────────────────────────
  gemini
    .command("app-bridge")
    .description(
      "Start a Gemini ACP bridge daemon. Spawns `gemini --acp` and connects it to " +
      "the registry. Incoming channel messages are delivered as ACP session/prompt " +
      "calls and Gemini's responses are relayed back to the channel.",
    )
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--project <path>", "Project path for client registration (default: cwd)")
    .option("--gemini-command <cmd>", "Gemini CLI executable name or path", "gemini")
    .option("--debug", "Enable ACP debug logging")
    .action(async (options) => {
      const projectPath = options.project ?? process.cwd();

      const bridge = new GeminiAcpBridge({
        registryUrl: options.registryUrl,
        projectPath,
        geminiCommand: options.geminiCommand,
        debug: options.debug === true,
      });

      console.log(chalk.bold("\n[agent-bridge] Gemini ACP bridge\n"));
      console.log(`  Project:  ${projectPath}`);
      console.log(`  Registry: ${options.registryUrl}`);
      console.log(`  Command:  ${options.geminiCommand}`);
      console.log();

      try {
        await bridge.start();
      } catch (err) {
        console.error(chalk.red("Failed to start bridge:"), err instanceof Error ? err.message : err);
        process.exit(1);
      }

      console.log(chalk.green("✓") + " Gemini ACP bridge running\n");

      const shutdown = async () => {
        console.log("\n[agent-bridge] Shutting down…");
        await bridge.stop();
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());

      // Keep process alive
      await new Promise<never>(() => undefined);
    });

  // ── gemini start ───────────────────────────────────────────────────────────
  gemini
    .command("start")
    .description(
      "Start Gemini with full ACP bridge in one command. Auto-starts the registry " +
      "if not running, then spawns the ACP bridge (which drives `gemini --acp`).",
    )
    .option("--project <path>", "Project path", process.cwd())
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--gemini-command <cmd>", "Gemini CLI executable name or path", "gemini")
    .option("--debug", "Enable ACP debug logging")
    .action(async (options) => {
      const projectPath = options.project ?? process.cwd();
      const registryUrl: string = options.registryUrl;

      console.log(chalk.bold("\n[agent-bridge] gemini start\n"));
      console.log(`  Project:  ${projectPath}`);
      console.log(`  Registry: ${registryUrl}`);
      console.log(`  Command:  ${options.geminiCommand}`);
      console.log();

      // 1. Ensure registry is running — embed one if not reachable
      let embeddedRegistry: RegistryServer | null = null;
      const registryClient = new RegistryClient(registryUrl);
      try {
        await registryClient.health();
        console.log(chalk.green("✓") + " Registry already running at " + registryUrl);
      } catch {
        console.log(chalk.yellow("→") + " Registry not found — starting embedded registry…");
        const registryPort = Number(new URL(registryUrl).port) || 4999;
        embeddedRegistry = new RegistryServer(registryPort);
        await embeddedRegistry.start();
        console.log(chalk.green("✓") + " Embedded registry started on :" + registryPort);
      }

      // 2. Start the ACP bridge
      const bridge = new GeminiAcpBridge({
        registryUrl,
        projectPath,
        geminiCommand: options.geminiCommand,
        debug: options.debug === true,
      });

      try {
        await bridge.start();
      } catch (err) {
        console.error(chalk.red("Failed to start Gemini ACP bridge:"), err instanceof Error ? err.message : err);
        if (embeddedRegistry) await embeddedRegistry.stop();
        process.exit(1);
      }

      console.log(chalk.green("✓") + " Gemini ACP bridge ready\n");

      const cleanup = async () => {
        await bridge.stop();
        if (embeddedRegistry) await embeddedRegistry.stop();
      };

      process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
      process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));

      // Keep process alive
      await new Promise<never>(() => undefined);
    });
}
