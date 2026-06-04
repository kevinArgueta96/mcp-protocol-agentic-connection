import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCliEntry,
  readDaemonMeta,
  writeDaemonMeta,
  clearDaemonMeta,
  readPid,
  metaFilePath,
  isPidAlive,
  whichBinary,
  isOnPath,
} from "../cli/lib/runtime.js";

describe("resolveCliEntry", () => {
  it("points at the compiled CLI entry", () => {
    expect(resolveCliEntry()).toMatch(/cli[\\/]index\.js$/);
  });
});

describe("daemon meta", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oab-rt-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips pid + port", () => {
    writeDaemonMeta(dir, { pid: 12345, port: 4998 });
    expect(readDaemonMeta(dir)).toEqual({ pid: 12345, port: 4998 });
    expect(readPid(dir)).toBe(12345);
  });

  it("returns null when no meta file exists", () => {
    expect(readDaemonMeta(dir)).toBeNull();
    expect(readPid(dir)).toBeNull();
  });

  it("clears the meta file", () => {
    writeDaemonMeta(dir, { pid: 1, port: 4999 });
    expect(existsSync(metaFilePath(dir))).toBe(true);
    clearDaemonMeta(dir);
    expect(existsSync(metaFilePath(dir))).toBe(false);
    expect(readDaemonMeta(dir)).toBeNull();
  });

  it("treats a corrupt/invalid meta file as absent", () => {
    writeDaemonMeta(dir, { pid: -1, port: 4999 });
    expect(readDaemonMeta(dir)).toBeNull();
  });
});

describe("isPidAlive", () => {
  it("is true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("is false for an almost-certainly-dead PID", () => {
    expect(isPidAlive(2_147_483_646)).toBe(false);
  });
});

describe("whichBinary / isOnPath", () => {
  it("resolves a binary that exists (node)", () => {
    expect(whichBinary("node")).not.toBeNull();
    expect(isOnPath("node")).toBe(true);
  });

  it("returns null for a non-existent binary", () => {
    expect(whichBinary("oab-definitely-not-a-real-binary-xyz")).toBeNull();
    expect(isOnPath("oab-definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
