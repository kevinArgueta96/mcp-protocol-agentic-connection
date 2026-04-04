import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface InboxFirstClientConfig {
  autoPollInbox?: boolean;
  sendReminderNotifications?: boolean;
  repeatReminders?: boolean;
  pollIntervalMs?: number;
  reminderIntervalMs?: number;
}

export interface McpBridgeConfig {
  clientAutomation?: {
    nonNative?: InboxFirstClientConfig;
    codex?: InboxFirstClientConfig;
    gemini?: InboxFirstClientConfig;
    [clientId: string]: InboxFirstClientConfig | undefined;
  };
}

export interface ResolvedInboxFirstClientConfig {
  autoPollInbox: boolean;
  sendReminderNotifications: boolean;
  repeatReminders: boolean;
  pollIntervalMs: number;
  reminderIntervalMs: number;
}

const DEFAULT_INBOX_FIRST_CONFIG: ResolvedInboxFirstClientConfig = {
  autoPollInbox: true,
  sendReminderNotifications: true,
  repeatReminders: true,
  pollIntervalMs: 5_000,
  reminderIntervalMs: 20_000,
};

function parseScalar(raw: string): string | number | boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseSimpleYaml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];

  for (const originalLine of content.split(/\r?\n/)) {
    const lineWithoutComment = originalLine.replace(/\s+#.*$/, "");
    if (!lineWithoutComment.trim()) continue;

    const indent = lineWithoutComment.match(/^ */)?.[0].length ?? 0;
    const trimmed = lineWithoutComment.trim();
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1]!.value;
    if (!rawValue) {
      const child: Record<string, unknown> = {};
      current[key] = child;
      stack.push({ indent, value: child });
      continue;
    }

    current[key] = parseScalar(rawValue);
  }

  return root;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function coerceInboxConfig(value: unknown): InboxFirstClientConfig {
  const obj = asObject(value);
  if (!obj) return {};
  return {
    autoPollInbox: typeof obj.autoPollInbox === "boolean" ? obj.autoPollInbox : undefined,
    sendReminderNotifications: typeof obj.sendReminderNotifications === "boolean" ? obj.sendReminderNotifications : undefined,
    repeatReminders: typeof obj.repeatReminders === "boolean" ? obj.repeatReminders : undefined,
    pollIntervalMs: typeof obj.pollIntervalMs === "number" ? obj.pollIntervalMs : undefined,
    reminderIntervalMs: typeof obj.reminderIntervalMs === "number" ? obj.reminderIntervalMs : undefined,
  };
}

export function loadMcpBridgeConfig(projectPath: string, explicitConfigPath?: string): McpBridgeConfig {
  const candidates = [
    explicitConfigPath ? (isAbsolute(explicitConfigPath) ? explicitConfigPath : resolve(projectPath, explicitConfigPath)) : undefined,
    join(projectPath, ".agent-bridge.mcp.yml"),
    join(projectPath, ".agent-bridge.yml"),
  ].filter((value): value is string => Boolean(value));

  const configPath = candidates.find((candidate) => existsSync(candidate));
  if (!configPath) return {};

  const parsed = parseSimpleYaml(readFileSync(configPath, "utf8"));
  const clientAutomation = asObject(parsed.clientAutomation);
  if (!clientAutomation) return {};

  const normalized: McpBridgeConfig["clientAutomation"] = {};
  for (const [key, value] of Object.entries(clientAutomation)) {
    normalized[key] = coerceInboxConfig(value);
  }

  return { clientAutomation: normalized };
}

export function resolveInboxFirstClientConfig(config: McpBridgeConfig, clientProfileId: string): ResolvedInboxFirstClientConfig {
  const nonNative = config.clientAutomation?.nonNative ?? {};
  const clientSpecific = config.clientAutomation?.[clientProfileId] ?? {};

  return {
    autoPollInbox: clientSpecific.autoPollInbox ?? nonNative.autoPollInbox ?? DEFAULT_INBOX_FIRST_CONFIG.autoPollInbox,
    sendReminderNotifications: clientSpecific.sendReminderNotifications ?? nonNative.sendReminderNotifications ?? DEFAULT_INBOX_FIRST_CONFIG.sendReminderNotifications,
    repeatReminders: clientSpecific.repeatReminders ?? nonNative.repeatReminders ?? DEFAULT_INBOX_FIRST_CONFIG.repeatReminders,
    pollIntervalMs: clientSpecific.pollIntervalMs ?? nonNative.pollIntervalMs ?? DEFAULT_INBOX_FIRST_CONFIG.pollIntervalMs,
    reminderIntervalMs: clientSpecific.reminderIntervalMs ?? nonNative.reminderIntervalMs ?? DEFAULT_INBOX_FIRST_CONFIG.reminderIntervalMs,
  };
}
