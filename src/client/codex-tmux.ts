import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TmuxBindingInfo {
  pane: string;
  sessionName?: string;
  windowName?: string;
  currentCommand?: string;
}

async function displayMessage(format: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("tmux", ["display-message", "-p", format]);
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function detectCurrentTmuxBinding(explicitPane?: string): Promise<TmuxBindingInfo | undefined> {
  const pane = explicitPane ?? process.env["TMUX_PANE"];
  if (!pane) return undefined;

  const sessionName = await displayMessage("#{session_name}");
  const windowName = await displayMessage("#{window_name}");
  const currentCommand = await displayMessage("#{pane_current_command}");

  return {
    pane,
    sessionName,
    windowName,
    currentCommand,
  };
}
