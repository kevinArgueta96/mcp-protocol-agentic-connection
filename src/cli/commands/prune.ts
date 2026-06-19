// `oab prune` — reap zombie registry entries.
//
// Background: the registry expires an entry only after ~2 min WITHOUT a
// heartbeat. A session whose UI (terminal / IDE tab) was closed but whose
// process leaked keeps heartbeating every 30 s, so the registry sees it as
// `healthy` forever and `oab list` shows a zombie. Deregistering such an entry
// is futile — the live process re-registers on its next heartbeat. The only
// durable fix is to STOP the owning process, which this command does.
//
// We locate the owning process two ways:
//   1. the `pid`/`host` stamped at registration (new sessions), or
//   2. by scanning local `open-agent-bridge mcp` processes and matching their
//      AGENT_BRIDGE_PROJECT env to the entry's projectPath (covers sessions
//      registered before pid stamping existed). Linux-only (reads /proc).
//
// Safety model (same host only — we never touch processes on another machine):
//   • dead     — no live process        → deregister
//   • orphaned — process alive but detached from any terminal (tty=?) or
//                reparented to init      → kill + deregister (--orphans / --all)
//   • live     — process on a real tty   → only acted on when targeted or --all
//   • unknown  — cannot locate a process → deregister only
import { readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import chalk from "chalk";
import { RegistryClient } from "../../client/registry-client.js";
import type { RegistryEntry } from "../../types/messages.js";

export type LocalStatus = "dead" | "orphaned" | "live" | "remote";

interface OabProc {
  pid: number;
  ppid: number;
  hasTty: boolean;
  project?: string;
}

/** True if `pid` is a running process (alive, even if owned by another user). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parse ppid (field 4) and tty_nr (field 7) from /proc/<pid>/stat. */
function readStat(pid: number): { ppid: number; ttyNr: number } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) is wrapped in parens and may contain spaces — slice past it.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // fields[0]=state, [1]=ppid, [2]=pgrp, [3]=session, [4]=tty_nr
    return { ppid: Number(fields[1]), ttyNr: Number(fields[4]) };
  } catch {
    return undefined;
  }
}

/** Scan /proc for `open-agent-bridge mcp` processes. Linux-only; [] elsewhere. */
export function scanLocalOabProcesses(): OabProc[] {
  const procs: OabProc[] = [];
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return procs; // non-Linux
  }
  for (const p of pids) {
    const pid = Number(p);
    let cmd: string;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (!cmd.includes("open-agent-bridge") || !/\bmcp\b/.test(cmd)) continue;
    const stat = readStat(pid);
    let project: string | undefined;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8");
      project = env.split("\0").find((e) => e.startsWith("AGENT_BRIDGE_PROJECT="))?.slice("AGENT_BRIDGE_PROJECT=".length);
    } catch { /* ignore */ }
    procs.push({ pid, ppid: stat?.ppid ?? 0, hasTty: (stat?.ttyNr ?? 0) !== 0, project });
  }
  return procs;
}

/** Resolve the owning pid(s) for an entry: the stamped pid, else local oab mcp
 *  processes whose AGENT_BRIDGE_PROJECT matches the entry's projectPath.
 *  `claimed` holds pids already owned by a pid-stamped entry — excluded from
 *  project-based matching so a live, stamped session isn't attributed to a
 *  separate pid-less (likely stale) entry for the same project. */
export function resolvePids(entry: RegistryEntry, procs: OabProc[], claimed: Set<number> = new Set()): OabProc[] {
  if (typeof entry.pid === "number") {
    const matched = procs.find((p) => p.pid === entry.pid);
    if (matched) return [matched];
    return isAlive(entry.pid) ? [{ pid: entry.pid, ppid: 0, hasTty: false }] : [];
  }
  return procs.filter((p) => p.project && p.project === entry.projectPath && !claimed.has(p.pid));
}

/** Pids that are definitively owned by a pid-stamped entry. */
export function claimedPids(agents: RegistryEntry[]): Set<number> {
  return new Set(agents.map((a) => a.pid).filter((p): p is number => typeof p === "number"));
}

export function classify(entry: RegistryEntry, thisHost: string, procs: OabProc[], claimed: Set<number> = new Set()): LocalStatus {
  if (entry.host && entry.host !== thisHost) return "remote";
  const owners = resolvePids(entry, procs, claimed);
  // No live process backing this entry → it is stale. Safe to deregister: a
  // genuinely live session would re-register on its next heartbeat (~30s).
  if (owners.length === 0) return "dead";
  // Orphaned if every owning process is detached from a terminal or reparented.
  const allOrphaned = owners.every((p) => !p.hasTty || p.ppid === 1);
  return allOrphaned ? "orphaned" : "live";
}

export function matchesTarget(entry: RegistryEntry, target: string): boolean {
  const t = target.toLowerCase();
  return (
    entry.agentId === target ||
    entry.agentId.toLowerCase().startsWith(t) ||
    entry.name.toLowerCase().includes(t) ||
    entry.projectName.toLowerCase().includes(t) ||
    entry.projectPath.toLowerCase().includes(t)
  );
}

export function registerPruneCommand(program: Command): void {
  program
    .command("prune")
    .description("Reap zombie agents (dead/orphaned processes; --all shuts every local session down)")
    .argument("[targets...]", "Agent ids, names, or project names to force-prune (kills the owning process)")
    .option("--orphans", "Also kill+remove live processes detached from any terminal (tty=?) or reparented to init")
    .option("--all", "Shut EVERYTHING down: kill every local open-agent-bridge session and clear the registry")
    .option("--dry-run", "Show what would be pruned without changing anything")
    .option("-y, --yes", "Skip the confirmation prompt before killing live processes")
    .option("--json", "Output the prune plan/result as JSON")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .action(async (targets: string[], options) => {
      const client = new RegistryClient(options.registryUrl);
      const thisHost = hostname();
      const procs = scanLocalOabProcesses();

      let agents: RegistryEntry[];
      try {
        agents = await client.listAgents();
      } catch {
        console.error(chalk.red("Error: Registry not available. Start it with: open-agent-bridge registry start"));
        process.exit(1);
      }

      const hasTargets = targets.length > 0;
      const claimed = claimedPids(agents);

      const plan = agents
        .map((entry) => {
          const status = classify(entry, thisHost, procs, claimed);
          const owners = resolvePids(entry, procs, claimed);
          let action: "kill" | "deregister" | null = null;
          let reason = "";

          if (options.all) {
            action = owners.length > 0 ? "kill" : "deregister";
            reason = "--all: shut everything down";
          } else if (hasTargets) {
            if (!targets.some((t) => matchesTarget(entry, t))) return null;
            if (status === "remote") { action = null; reason = "remote host — cannot act"; }
            else if (owners.length > 0) { action = "kill"; reason = `targeted, process alive (${status})`; }
            else { action = "deregister"; reason = "targeted, no local process found"; }
          } else {
            if (status === "dead") { action = "deregister"; reason = "process dead"; }
            else if (status === "orphaned" && options.orphans) { action = "kill"; reason = "orphaned (no terminal / reparented)"; }
          }

          return action ? { entry, status, action, reason, owners } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (options.json) {
        console.log(JSON.stringify(
          plan.map((p) => ({ agentId: p.entry.agentId, name: p.entry.name, pids: p.owners.map((o) => o.pid), status: p.status, action: p.action, reason: p.reason })),
          null, 2,
        ));
      }

      if (plan.length === 0) {
        if (!options.json) {
          console.log(chalk.green("Nothing to prune.") +
            (hasTargets || options.all ? "" : chalk.dim(" (use --orphans for orphaned live sessions, --all to shut everything down, or pass a target)")));
        }
        return;
      }

      if (!options.json) {
        console.log(chalk.bold(`\nPrune plan (${plan.length})\n`));
        for (const { entry, status, action, reason, owners } of plan) {
          const verb = action === "kill" ? chalk.red("kill+remove") : chalk.yellow("remove");
          const pids = owners.map((o) => o.pid).join(",") || "—";
          console.log(`  ${verb}  ${chalk.cyan(entry.name)} ${chalk.dim(`(${entry.agentId})`)}`);
          console.log(`    pid(s): ${pids}  status: ${status}  — ${reason}`);
        }
        console.log();
      }

      if (options.dryRun) {
        if (!options.json) console.log(chalk.dim("Dry run — no changes made."));
        return;
      }

      const willKill = plan.some((p) => p.action === "kill");
      if (willKill && !options.yes && !options.json) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question(chalk.yellow("Kill the process(es) above and remove them? [y/N] "))).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") {
          console.log(chalk.dim("Aborted."));
          return;
        }
      }

      let killed = 0;
      let removed = 0;
      for (const { entry, action, owners } of plan) {
        if (action === "kill") {
          for (const owner of owners) {
            try { process.kill(owner.pid, "SIGTERM"); killed++; }
            catch (err) {
              if (!options.json) console.error(chalk.red(`  Failed to kill pid ${owner.pid} (${entry.name}): ${(err as Error).message}`));
            }
          }
        }
        try { await client.deregister(entry.agentId); removed++; }
        catch { /* may already be gone */ }
      }

      if (!options.json) {
        console.log(chalk.green(`✓ Pruned ${removed} entr${removed === 1 ? "y" : "ies"}` + (killed ? `, killed ${killed} process${killed === 1 ? "" : "es"}` : "") + "."));
      }
    });
}
