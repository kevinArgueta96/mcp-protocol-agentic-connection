// Shared runtime helpers for the CLI: registry daemon lifecycle + PATH probing.
//
// The registry is the hub every client connects to. Historically it could only
// run in the foreground (blocking a terminal). These helpers let us run it as a
// detached background daemon with a PID file, so `oab up`/`oab down`/`oab status`
// and the launchers can manage it without a dedicated terminal.
import { spawn, execFileSync } from "node:child_process";
import { openSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RegistryClient } from "../../client/registry-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_REGISTRY_PORT = 4999;
export const DEFAULT_REGISTRY_URL = `http://localhost:${DEFAULT_REGISTRY_PORT}`;

/** Absolute path to the compiled CLI entry (dist/cli/index.js).
 *  Resolved from THIS module's location — never `process.argv[1]`, which points
 *  at the global bin shim when installed via `npm i -g` / `pnpm link`. */
export function resolveCliEntry(): string {
  // dist/cli/lib/runtime.js → ../index.js  ⇒  dist/cli/index.js
  return resolve(__dirname, "../index.js");
}

/** Runtime state directory (PID file, SQLite, session markers). Relative to the
 *  given cwd because ChannelStore resolves its SQLite path against process.cwd();
 *  the daemon must be launched with a stable cwd so all three stay coherent. */
export function stateDir(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".open-agent-bridge");
}

export function metaFilePath(cwd: string = process.cwd()): string {
  return join(stateDir(cwd), "registry.json");
}

export function logFilePath(cwd: string = process.cwd()): string {
  return join(stateDir(cwd), "registry.log");
}

export interface DaemonMeta {
  pid: number;
  port: number;
}

/** Read the daemon meta (pid + port) written by `startDaemon`. */
export function readDaemonMeta(cwd: string = process.cwd()): DaemonMeta | null {
  const file = metaFilePath(cwd);
  if (!existsSync(file)) return null;
  try {
    const meta = JSON.parse(readFileSync(file, "utf-8")) as Partial<DaemonMeta>;
    if (!Number.isInteger(meta.pid) || (meta.pid as number) <= 0) return null;
    return { pid: meta.pid as number, port: meta.port ?? DEFAULT_REGISTRY_PORT };
  } catch {
    return null;
  }
}

/** Convenience: just the daemon PID, or null. */
export function readPid(cwd: string = process.cwd()): number | null {
  return readDaemonMeta(cwd)?.pid ?? null;
}

export function writeDaemonMeta(cwd: string, meta: DaemonMeta): void {
  mkdirSync(stateDir(cwd), { recursive: true });
  writeFileSync(metaFilePath(cwd), JSON.stringify(meta) + "\n", "utf-8");
}

export function clearDaemonMeta(cwd: string = process.cwd()): void {
  try {
    rmSync(metaFilePath(cwd), { force: true });
  } catch {
    /* ignore */
  }
}

/** True if a process with this PID exists. EPERM means it exists but is owned by
 *  another user — still "alive" for our purposes. ESRCH means it's gone. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isRegistryUp(registryUrl: string = DEFAULT_REGISTRY_URL): Promise<boolean> {
  return new RegistryClient(registryUrl).isAvailable();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until the registry reaches the desired up/down state, or the timeout. */
export async function waitForRegistry(
  registryUrl: string,
  opts: { up: boolean; timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isRegistryUp(registryUrl)) === opts.up) return true;
    await sleep(intervalMs);
  }
  return false;
}

export interface DaemonOptions {
  cwd?: string;
  port?: number;
  registryUrl?: string;
}

export interface StartDaemonResult {
  pid: number;
  alreadyRunning: boolean;
}

/** Start the registry as a detached background daemon. Idempotent: if a registry
 *  is already answering, returns without spawning a second one. */
export async function startDaemon(opts: DaemonOptions = {}): Promise<StartDaemonResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const port = opts.port ?? DEFAULT_REGISTRY_PORT;
  const registryUrl = opts.registryUrl ?? `http://localhost:${port}`;

  if (await isRegistryUp(registryUrl)) {
    return { pid: readPid(cwd) ?? -1, alreadyRunning: true };
  }

  mkdirSync(stateDir(cwd), { recursive: true });
  const logFd = openSync(logFilePath(cwd), "a");

  const child = spawn(
    process.execPath,
    [resolveCliEntry(), "registry", "start", "--port", String(port)],
    { cwd, detached: true, stdio: ["ignore", logFd, logFd] },
  );
  child.unref();
  if (child.pid) writeDaemonMeta(cwd, { pid: child.pid, port });

  const ready = await waitForRegistry(registryUrl, { up: true, timeoutMs: 10_000 });
  if (!ready) {
    throw new Error(
      `Registry daemon did not become ready on ${registryUrl}. See ${logFilePath(cwd)}`,
    );
  }
  return { pid: child.pid ?? -1, alreadyRunning: false };
}

export type StopReason =
  | "stopped"
  | "not-running"
  | "stale-pid-cleared"
  | "running-without-pidfile";

/** Stop the daemon via its meta file. Always clears a stale meta file. The
 *  down-poll targets the port the daemon was actually started on. */
export async function stopDaemon(
  opts: { cwd?: string; registryUrl?: string } = {},
): Promise<{ stopped: boolean; reason: StopReason }> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const meta = readDaemonMeta(cwd);
  const registryUrl = opts.registryUrl ?? (meta ? `http://localhost:${meta.port}` : DEFAULT_REGISTRY_URL);

  if (meta === null) {
    if (await isRegistryUp(registryUrl)) return { stopped: false, reason: "running-without-pidfile" };
    return { stopped: false, reason: "not-running" };
  }

  if (!isPidAlive(meta.pid)) {
    clearDaemonMeta(cwd);
    return { stopped: false, reason: "stale-pid-cleared" };
  }

  try {
    process.kill(meta.pid, "SIGTERM");
  } catch {
    /* already gone */
  }

  const down = await waitForRegistry(registryUrl, { up: false, timeoutMs: 8_000 });
  if (!down && isPidAlive(meta.pid)) {
    try {
      process.kill(meta.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  clearDaemonMeta(cwd);
  return { stopped: true, reason: "stopped" };
}

/** Ensure a registry is reachable; start a daemon if not. Health-first, so it
 *  reuses a registry already started elsewhere (e.g. by `mcp start`/`codex start`). */
export async function ensureRegistry(opts: DaemonOptions = {}): Promise<{ started: boolean }> {
  const port = opts.port ?? DEFAULT_REGISTRY_PORT;
  const registryUrl = opts.registryUrl ?? `http://localhost:${port}`;
  if (await isRegistryUp(registryUrl)) return { started: false };
  await startDaemon({ ...opts, port, registryUrl });
  return { started: true };
}

/** Resolve a binary's absolute path from PATH, or null if not found. */
export function whichBinary(name: string): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [name], { encoding: "utf8" });
    const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

export function isOnPath(name: string): boolean {
  return whichBinary(name) !== null;
}
