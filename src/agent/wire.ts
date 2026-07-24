// A2A wire normalization.
//
// The spec (and @a2a-js/sdk) tag message Parts with `kind`; this codebase was
// built against an older draft that used `type`. Instead of renaming `type`
// across every handler/skill/client (and breaking the 5 existing profiles), we
// normalize at the JSON-RPC boundary: every Part carries BOTH keys. External
// A2A clients read `kind`, internal code keeps reading `type`, nobody breaks.
//
// Dualization is SCOPED to known Part positions (message.parts, task history,
// status.message, artifacts) — never a blind deep walk. Payloads like
// DataPart.data, metadata, and skill results are opaque: an object in there
// whose `type` happens to be "text"/"file"/"data" must not be rewritten.
//
// ponytail: boundary dualization over a repo-wide rename — same interop, 1 file.

const PART_KINDS = new Set(["text", "file", "data"]);

/** Stamp both `kind` and `type` on a single Part. Top-level keys only — never
 *  recurses into `data`/`metadata`/`file` payloads. */
function stampPart(part: unknown): void {
  if (!part || typeof part !== "object") return;
  const obj = part as Record<string, unknown>;
  const tag = obj.kind ?? obj.type;
  if (typeof tag === "string" && PART_KINDS.has(tag)) {
    obj.kind = tag;
    obj.type = tag;
  }
}

/** Dualize the Parts of anything Message-shaped (or Artifact-shaped): an object
 *  with a `parts` array. Mutates in place and returns the input. */
export function dualizeMessage<T>(message: T): T {
  const parts = (message as { parts?: unknown[] } | null | undefined)?.parts;
  if (Array.isArray(parts)) for (const part of parts) stampPart(part);
  return message;
}

/** Dualize the known Part positions of a Task: `history[].parts`,
 *  `status.message.parts`, and `artifacts[].parts`. Safe no-op on non-Tasks. */
export function dualizeTask<T>(task: T): T {
  if (!task || typeof task !== "object") return task;
  const t = task as {
    history?: unknown[];
    status?: { message?: unknown };
    artifacts?: unknown[];
  };
  if (Array.isArray(t.history)) for (const message of t.history) dualizeMessage(message);
  if (t.status?.message) dualizeMessage(t.status.message);
  if (Array.isArray(t.artifacts)) for (const artifact of t.artifacts) dualizeMessage(artifact);
  return task;
}
