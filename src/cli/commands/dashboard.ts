import type { Command } from "commander";
import { exec } from "node:child_process";
import { platform } from "node:os";

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .description("Open the open-agent-bridge dashboard in your browser")
    .option("--no-open", "Print URL without opening browser")
    .option("--port <number>", "Registry port", "4999")
    .action((options: { open: boolean; port: string }) => {
      const url = `http://localhost:${options.port}/dashboard`;
      console.log(`Dashboard: ${url}`);
      if (options.open) {
        const cmd =
          platform() === "darwin" ? `open "${url}"` :
          platform() === "win32" ? `start "${url}"` :
          `xdg-open "${url}"`;
        exec(cmd, (err) => {
          if (err) console.error(`Could not open browser: ${err.message}`);
        });
      }
    });
}
