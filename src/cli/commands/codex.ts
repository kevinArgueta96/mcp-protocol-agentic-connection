import type { Command } from "commander";
import chalk from "chalk";
import { CodexTmuxBridgeService } from "../../client/codex-tmux-bridge-service.js";
import { detectCurrentTmuxBinding } from "../../client/codex-tmux.js";
import { readCurrentCodexSession, writeCurrentCodexSession } from "../../client/codex-session-files.js";

export function registerCodexCommand(program: Command): void {
  const codex = program.command("codex").description("Codex-specific utilities");

  codex
    .command("tmux-bind")
    .description("Bind the current Codex client session to a tmux pane so agent-bridge can inject follow-up prompts")
    .option("--project <path>", "Project path override", process.cwd())
    .option("--client-id <id>", "Exact Codex client session ID to bind")
    .option("--pane <pane>", "Explicit tmux pane target, for example %12")
    .action(async (options) => {
      const binding = await detectCurrentTmuxBinding(options.pane);
      if (!binding?.pane) {
        console.error(chalk.red("No tmux pane detected. Run this inside tmux or pass --pane explicitly."));
        process.exit(1);
      }

      const current = readCurrentCodexSession(options.project);
      const clientAgentId = options.clientId ?? current?.clientAgentId;
      if (!clientAgentId) {
        console.error(chalk.red("No Codex client session marker found. Start Codex first or pass --client-id."));
        process.exit(1);
      }

      writeCurrentCodexSession(options.project, {
        clientAgentId,
        clientName: current?.clientName ?? "codex",
        projectPath: options.project,
        registeredAt: current?.registeredAt ?? Date.now(),
        sidecarPid: current?.sidecarPid,
        tmuxPane: binding.pane,
        tmuxSessionName: binding.sessionName,
        tmuxWindowName: binding.windowName,
        tmuxCurrentCommand: binding.currentCommand,
      });

      console.log(chalk.green("✓") + " Codex tmux binding updated");
      console.log(`  Client: ${clientAgentId}`);
      console.log(`  Pane: ${binding.pane}`);
      if (binding.sessionName) console.log(`  Session: ${binding.sessionName}`);
      if (binding.windowName) console.log(`  Window: ${binding.windowName}`);
      if (binding.currentCommand) console.log(`  Command: ${binding.currentCommand}`);
    });

  codex
    .command("tmux-sidecar")
    .description("Run a per-session tmux sidecar that injects pending channel follow-ups into the active Codex pane")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--project <path>", "Project path override", process.cwd())
    .option("--client-id <id>", "Exact Codex client session ID to control")
    .option("--tmux-pane <pane>", "Explicit tmux pane target, for example %12")
    .option("--poll-interval-ms <number>", "Polling interval in milliseconds", "2000")
    .option("--retry-interval-ms <number>", "Retry interval for the same pending message", "30000")
    .option("--verbose", "Enable verbose sidecar logs")
    .option("--once", "Run one poll cycle and exit")
    .action(async (options) => {
      const service = new CodexTmuxBridgeService({
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
        console.log(chalk.cyan(`[Codex Tmux Sidecar] scanned ${pending.length} pending conversation(s)`));
        return;
      }

      console.log(chalk.green("✓") + " Codex tmux sidecar running");
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
}
