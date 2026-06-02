import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseAntigravityHistory,
  resolveConversationIdForWorkspace,
} from "../client/antigravity-history.js";

/**
 * Antigravity stores its CLI prompt history as JSONL at
 * ~/.gemini/antigravity-cli/history.jsonl. Each line:
 *   {"display": "<prompt>", "timestamp": <ms>, "workspace": "<abs path>", "conversationId": "<uuid>"}
 * conversationId may be absent on some lines. The headless relay needs the
 * most-recent conversationId for a given workspace.
 */

let dir: string;
let historyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agy-hist-"));
  historyPath = join(dir, "history.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseAntigravityHistory", () => {
  it("parses valid JSONL lines and skips blank/corrupt ones", () => {
    writeFileSync(
      historyPath,
      [
        '{"display":"hello","timestamp":1,"workspace":"/w/a","conversationId":"c1"}',
        "",
        "not json",
        '{"display":"hi","timestamp":2,"workspace":"/w/b"}',
      ].join("\n"),
      "utf8",
    );

    const entries = parseAntigravityHistory(historyPath);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ workspace: "/w/a", conversationId: "c1" });
    expect(entries[1].conversationId).toBeUndefined();
  });

  it("returns an empty array when the file does not exist", () => {
    expect(parseAntigravityHistory(join(dir, "missing.jsonl"))).toEqual([]);
  });
});

describe("resolveConversationIdForWorkspace", () => {
  it("returns the conversationId of the most-recent entry for the workspace", () => {
    writeFileSync(
      historyPath,
      [
        '{"display":"old","timestamp":100,"workspace":"/w/a","conversationId":"old"}',
        '{"display":"new","timestamp":300,"workspace":"/w/a","conversationId":"new"}',
        '{"display":"other","timestamp":999,"workspace":"/w/b","conversationId":"b"}',
      ].join("\n"),
      "utf8",
    );

    expect(resolveConversationIdForWorkspace(historyPath, "/w/a")).toBe("new");
  });

  it("ignores entries for the workspace that lack a conversationId", () => {
    writeFileSync(
      historyPath,
      [
        '{"display":"withid","timestamp":100,"workspace":"/w/a","conversationId":"keep"}',
        '{"display":"noid","timestamp":500,"workspace":"/w/a"}',
      ].join("\n"),
      "utf8",
    );

    expect(resolveConversationIdForWorkspace(historyPath, "/w/a")).toBe("keep");
  });

  it("returns undefined when the workspace has no entries", () => {
    writeFileSync(
      historyPath,
      '{"display":"x","timestamp":1,"workspace":"/w/a","conversationId":"c1"}\n',
      "utf8",
    );

    expect(resolveConversationIdForWorkspace(historyPath, "/w/unknown")).toBeUndefined();
  });
});
