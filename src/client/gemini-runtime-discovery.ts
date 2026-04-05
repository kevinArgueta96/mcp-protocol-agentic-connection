import { listTmuxPanes, getTmuxPaneInfo } from "./codex-runtime-discovery.js";
import type { TmuxPaneInfo } from "./codex-runtime-discovery.js";

export type { TmuxPaneInfo };
export { getTmuxPaneInfo };

// "gemini" is the binary name; "node" catches npm-linked / npx invocations.
const ACTIVE_PANE_COMMANDS = new Set(["gemini", "node"]);

export function isInteractiveGeminiPane(pane: TmuxPaneInfo | undefined): boolean {
  if (!pane) return false;
  return ACTIVE_PANE_COMMANDS.has(pane.currentCommand.toLowerCase());
}

export async function discoverGeminiPaneForProject(projectPath: string): Promise<TmuxPaneInfo | undefined> {
  const panes = await listTmuxPanes();

  const exactProjectPane = panes.find(
    (pane) =>
      pane.currentPath === projectPath &&
      ACTIVE_PANE_COMMANDS.has(pane.currentCommand.toLowerCase()),
  );
  if (exactProjectPane) return exactProjectPane;

  return panes.find(
    (pane) =>
      pane.currentPath === projectPath ||
      pane.title.includes(projectPath.split("/").pop() ?? ""),
  );
}
