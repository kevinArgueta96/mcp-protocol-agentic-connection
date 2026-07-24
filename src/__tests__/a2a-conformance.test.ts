import { describe, expect, it } from "vitest";
import { generateAgentCard } from "../agent/card.js";
import { RequestRouter, TaskStore, type RouterContext } from "../agent/handlers.js";
import { dualizeMessage, dualizeTask } from "../agent/wire.js";
import { createDefaultRegistry } from "../skills/index.js";

function makeCtx(): RouterContext {
  const skillRegistry = createDefaultRegistry();
  return {
    agentId: "test-agent",
    projectPath: "/tmp/proj",
    projectName: "proj",
    projectType: "node",
    taskStore: new TaskStore("test-agent"),
    skillRegistry,
  };
}

describe("A2A conformance (fixes 1-3)", () => {
  // Fix 3: card carries the spec-required protocolVersion.
  it("agent card declares protocolVersion", () => {
    const card = generateAgentCard({
      agentId: "a",
      port: 1234,
      projectInfo: { type: "node", name: "p", rootDir: "/tmp/p" },
      skills: [],
    });
    expect(card.protocolVersion).toBeTruthy();
    expect(card.preferredTransport).toBe("JSONRPC");
  });

  // Fix 4: Task carries the spec discriminator and always has a contextId.
  it("message/send returns a Task with kind and contextId", async () => {
    const router = new RequestRouter();
    const res = await router.dispatch(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "message/send",
        params: { message: { role: "user", parts: [{ kind: "text", text: "hello" }] } },
      },
      makeCtx(),
    );
    const task = (res as { result: { kind?: string; contextId?: string } }).result;
    expect(task.kind).toBe("task");
    expect(task.contextId).toBeTruthy();
  });

  // Fix 2: the spec method name message/send is accepted (alias of tasks/send).
  it("router accepts message/send", async () => {
    const router = new RequestRouter();
    const res = await router.dispatch(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { role: "user", parts: [{ kind: "text", text: "hello" }] } },
      },
      makeCtx(),
    );
    expect("result" in res).toBe(true);
  });

  // Fix 2: legacy tasks/send still works (no regression for current clients).
  it("router still accepts legacy tasks/send", async () => {
    const router = new RequestRouter();
    const res = await router.dispatch(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/send",
        params: { message: { role: "user", parts: [{ type: "text", text: "hi" }] } },
      },
      makeCtx(),
    );
    expect("result" in res).toBe(true);
  });

  // Fix 2: an external client sending only `kind` is understood (skill inference reads it).
  it("message/send with kind-only text reaches skill inference", async () => {
    const router = new RequestRouter();
    const res = await router.dispatch(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "message/send",
        // "search the codebase" should infer the code-query skill via kind:text
        params: {
          message: dualizeMessage({ role: "user", parts: [{ kind: "text", text: "find usages in the code" }] }),
        },
        // biome-ignore lint/suspicious/noExplicitAny: test shape
      } as any,
      makeCtx(),
    );
    expect("result" in res).toBe(true);
  });
});

describe("scoped wire dualization (Fix 1: kind<->type)", () => {
  it("adds kind when only type is present on a message part", () => {
    const out = dualizeMessage({ parts: [{ type: "text", text: "x" }] });
    expect(out.parts[0]).toMatchObject({ type: "text", kind: "text" });
  });

  it("adds type when only kind is present on a message part", () => {
    const out = dualizeMessage({ parts: [{ kind: "data", data: { a: 1 } }] });
    expect(out.parts[0]).toMatchObject({ kind: "data", type: "data" });
  });

  it("dualizes task history, status.message, and artifact parts", () => {
    const out = dualizeTask({
      history: [{ role: "user", parts: [{ type: "text", text: "h" }] }],
      status: { message: { parts: [{ kind: "text", text: "s" }] } },
      artifacts: [{ parts: [{ type: "data", data: {} }] }],
    });
    expect(out.history[0].parts[0]).toMatchObject({ kind: "text", type: "text" });
    expect(out.status.message.parts[0]).toMatchObject({ kind: "text", type: "text" });
    expect(out.artifacts[0].parts[0]).toMatchObject({ kind: "data", type: "data" });
  });

  it("never rewrites opaque payloads inside a Part's data", () => {
    // Regression: a blind deep walk stamped kind/type on payload objects and
    // even OVERWROTE conflicting `type` fields ({kind:"file", type:"markdown"}).
    const doc = { kind: "file", type: "markdown" };
    const note = { type: "data", format: "csv" };
    const out = dualizeTask({
      artifacts: [{ parts: [{ type: "data", data: { doc, note } }] }],
    });
    expect(out.artifacts[0].parts[0]).toMatchObject({ kind: "data", type: "data" });
    expect(doc).toEqual({ kind: "file", type: "markdown" });
    expect(note).toEqual({ type: "data", format: "csv" });
  });

  it("leaves non-part objects untouched", () => {
    const out = dualizeMessage({ type: "node", name: "proj" });
    expect(out).toEqual({ type: "node", name: "proj" });
  });
});

describe("MessageSendParams unwrapping (spec 0.3.0 shapes)", () => {
  it("honors message.contextId from a spec client", async () => {
    const router = new RequestRouter();
    const res = await router.dispatch(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "message/send",
        params: {
          message: { role: "user", contextId: "ctx-abc", parts: [{ kind: "text", text: "hello" }] },
        },
      },
      makeCtx(),
    );
    const task = (res as { result: { contextId?: string } }).result;
    expect(task.contextId).toBe("ctx-abc");
  });

  it("message/send with message.taskId resumes an input-required task instead of overwriting it", async () => {
    const ctx = makeCtx();
    const router = new RequestRouter();
    const created = ctx.taskStore.create({
      message: { role: "user", parts: [{ type: "text", text: "start" }] },
    });
    ctx.taskStore.awaitInput(created.id, {
      conversationId: "conv-1",
      messageId: "m-1",
      content: "waiting",
    });

    const res = await router.dispatch(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "message/send",
        params: {
          message: { role: "user", taskId: created.id, parts: [{ kind: "text", text: "the answer" }] },
        },
      },
      ctx,
    );
    const task = (res as { result: { id: string; status: { state: string } } }).result;
    expect(task.id).toBe(created.id);
    expect(task.status.state).toBe("completed");
  });
});
