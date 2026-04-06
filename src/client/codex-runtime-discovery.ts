import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACTIVE_PANE_COMMANDS = new Set(["codex", "node"]);

function isCodexCommand(command: string | undefined): boolean {
  if (!command) return false;
  const normalized = command.toLowerCase();
  return ACTIVE_PANE_COMMANDS.has(normalized) || normalized.startsWith("codex-");
}

export interface TmuxPaneInfo {
  sessionName: string;
  windowRef: string;
  paneId: string;
  currentCommand: string;
  currentPath: string;
  title: string;
}

export interface CodexSessionFact {
  id: string;
  timestampMs: number;
  workingDirectory?: string;
  path: string;
}

interface SessionFileShape {
  session?: {
    id?: string;
    timestamp?: string;
  };
  items?: Array<{
    type?: string;
    action?: {
      working_directory?: string;
    };
  }>;
}

export async function listTmuxPanes(): Promise<TmuxPaneInfo[]> {
  const { stdout } = await execFileAsync("tmux", [
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}",
  ]);

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sessionName = "", windowRef = "", paneId = "", currentCommand = "", currentPath = "", title = ""] = line.split("\t");
      return { sessionName, windowRef, paneId, currentCommand, currentPath, title };
    });
}

export async function getTmuxPaneInfo(paneId: string): Promise<TmuxPaneInfo | undefined> {
  const panes = await listTmuxPanes();
  return panes.find((pane) => pane.paneId === paneId);
}

export function listCodexSessionFacts(limit = 50): CodexSessionFact[] {
  const sessionsDir = join(homedir(), ".codex", "sessions");
  if (!existsSync(sessionsDir)) return [];

  const files = readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(sessionsDir, name))
    .slice(-limit);

  const facts: CodexSessionFact[] = [];
  for (const path of files) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionFileShape;
      const timestampMs = parsed.session?.timestamp ? Date.parse(parsed.session.timestamp) : 0;
      const workingDirectory = parsed.items
        ?.find((item) => item.type === "local_shell_call" && item.action?.working_directory)
        ?.action?.working_directory;

      if (!parsed.session?.id || !timestampMs) continue;
      facts.push({
        id: parsed.session.id,
        timestampMs,
        workingDirectory,
        path,
      });
    } catch {
      // Ignore malformed historical sessions.
    }
  }

  return facts.sort((a, b) => b.timestampMs - a.timestampMs);
}

export async function discoverCodexPaneForProject(projectPath: string): Promise<TmuxPaneInfo | undefined> {
  const panes = await listTmuxPanes();
  const exactProjectPane = panes.find((pane) =>
    pane.currentPath === projectPath && isCodexCommand(pane.currentCommand)
  );
  if (exactProjectPane) return exactProjectPane;

  const sessionFacts = listCodexSessionFacts();
  const recentProjectSession = sessionFacts.find((fact) => fact.workingDirectory === projectPath);
  if (!recentProjectSession) return undefined;

  return panes.find((pane) =>
    pane.currentPath === projectPath || pane.title.includes(projectPath.split("/").pop() ?? "")
  );
}

export function isInteractiveCodexPane(pane: TmuxPaneInfo | undefined): boolean {
  if (!pane) return false;
  return isCodexCommand(pane.currentCommand);
}
