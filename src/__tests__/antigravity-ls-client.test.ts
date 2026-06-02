import { describe, expect, it } from "vitest";
import {
  parseLatestHttpPort,
  pickActiveCascadeId,
} from "../client/antigravity-ls-client.js";

/**
 * The Antigravity (`agy`) Cascade Language Server listens on two random
 * localhost ports — one HTTP (connect/JSON), one HTTPS (gRPC). The CLI log
 * announces both; we drive the HTTP one. SendUserCascadeMessage needs the
 * active cascadeId of the workspace's most-recent trajectory.
 */

describe("parseLatestHttpPort", () => {
  it("extracts the HTTP port (not the gRPC one) from the log", () => {
    const log = [
      "I0602 server.go:489] Language server listening on random port at 38793 for HTTPS (gRPC)",
      "I0602 server.go:496] Language server listening on random port at 43473 for HTTP",
    ].join("\n");
    expect(parseLatestHttpPort(log)).toBe(43473);
  });

  it("returns the LAST HTTP port when the log has several (restarts)", () => {
    const log = [
      "listening on random port at 11111 for HTTP",
      "listening on random port at 22222 for HTTPS (gRPC)",
      "listening on random port at 33333 for HTTP",
    ].join("\n");
    expect(parseLatestHttpPort(log)).toBe(33333);
  });

  it("returns undefined when no HTTP port line is present", () => {
    expect(parseLatestHttpPort("nothing here\nlistening on random port at 9 for HTTPS (gRPC)")).toBeUndefined();
  });
});

describe("pickActiveCascadeId", () => {
  const ws = "file:///home/u/proj";
  const resp = {
    trajectorySummaries: {
      old: {
        lastModifiedTime: "2026-06-02T10:00:00Z",
        status: "CASCADE_RUN_STATUS_IDLE",
        workspaces: [{ workspaceFolderAbsoluteUri: ws }],
      },
      newest: {
        lastModifiedTime: "2026-06-02T12:00:00Z",
        status: "CASCADE_RUN_STATUS_IDLE",
        workspaces: [{ workspaceFolderAbsoluteUri: ws }],
      },
      otherWorkspace: {
        lastModifiedTime: "2026-06-02T23:00:00Z",
        status: "CASCADE_RUN_STATUS_IDLE",
        workspaces: [{ workspaceFolderAbsoluteUri: "file:///home/u/other" }],
      },
    },
  };

  it("returns the most-recent cascadeId for the matching workspace", () => {
    expect(pickActiveCascadeId(resp, "/home/u/proj")).toBe("newest");
  });

  it("ignores trajectories of other workspaces", () => {
    expect(pickActiveCascadeId(resp, "/home/u/proj")).not.toBe("otherWorkspace");
  });

  it("returns undefined when no trajectory matches the workspace", () => {
    expect(pickActiveCascadeId(resp, "/home/u/nope")).toBeUndefined();
  });

  it("returns undefined for an empty trajectory set", () => {
    expect(pickActiveCascadeId({ trajectorySummaries: {} }, "/home/u/proj")).toBeUndefined();
  });
});
