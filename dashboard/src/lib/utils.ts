// Shared utilities

export function randomUUID(): string {
  return crypto.randomUUID();
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function projectTypeBadge(type: string): string {
  const map: Record<string, string> = {
    node: "JS",
    rust: "RS",
    go: "GO",
    python: "PY",
    java: "JV",
    unknown: "??",
  };
  return map[type] ?? "??";
}

export const STATE_COLORS: Record<string, string> = {
  submitted: "text-blue-400 border-blue-500",
  working: "text-amber-400 border-amber-500",
  completed: "text-emerald-400 border-emerald-500",
  failed: "text-red-400 border-red-500",
  canceled: "text-zinc-400 border-zinc-500",
};

export const STATE_BG: Record<string, string> = {
  submitted: "bg-blue-500/10",
  working: "bg-amber-500/10",
  completed: "bg-emerald-500/10",
  failed: "bg-red-500/10",
  canceled: "bg-zinc-500/10",
};
