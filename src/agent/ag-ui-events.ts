// AG-UI event factory functions + SSE helper
// Plain objects mirroring @ag-ui/core EventType — no import of frontend package needed

export const AgUiEventType = {
  RUN_STARTED: "RUN_STARTED",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  STEP_STARTED: "STEP_STARTED",
  STEP_FINISHED: "STEP_FINISHED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  CUSTOM: "CUSTOM",
} as const;

export type AgUiEventTypeName = (typeof AgUiEventType)[keyof typeof AgUiEventType];

interface BaseEvent {
  type: AgUiEventTypeName;
  timestamp: number;
}

export function runStarted(threadId: string, runId: string): BaseEvent & { threadId: string; runId: string } {
  return { type: AgUiEventType.RUN_STARTED, timestamp: Date.now(), threadId, runId };
}

export function textMessageStart(messageId: string, role = "assistant"): BaseEvent & { messageId: string; role: string } {
  return { type: AgUiEventType.TEXT_MESSAGE_START, timestamp: Date.now(), messageId, role };
}

export function textMessageContent(messageId: string, delta: string): BaseEvent & { messageId: string; delta: string } {
  return { type: AgUiEventType.TEXT_MESSAGE_CONTENT, timestamp: Date.now(), messageId, delta };
}

export function textMessageEnd(messageId: string): BaseEvent & { messageId: string } {
  return { type: AgUiEventType.TEXT_MESSAGE_END, timestamp: Date.now(), messageId };
}

export function toolCallStart(
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string
): BaseEvent & { toolCallId: string; toolCallName: string; parentMessageId: string } {
  return { type: AgUiEventType.TOOL_CALL_START, timestamp: Date.now(), toolCallId, toolCallName, parentMessageId };
}

export function toolCallArgs(toolCallId: string, delta: string): BaseEvent & { toolCallId: string; delta: string } {
  return { type: AgUiEventType.TOOL_CALL_ARGS, timestamp: Date.now(), toolCallId, delta };
}

export function toolCallEnd(toolCallId: string): BaseEvent & { toolCallId: string } {
  return { type: AgUiEventType.TOOL_CALL_END, timestamp: Date.now(), toolCallId };
}

export function stepStarted(stepName: string): BaseEvent & { stepName: string } {
  return { type: AgUiEventType.STEP_STARTED, timestamp: Date.now(), stepName };
}

export function stepFinished(stepName: string): BaseEvent & { stepName: string } {
  return { type: AgUiEventType.STEP_FINISHED, timestamp: Date.now(), stepName };
}

export function runFinished(threadId: string, runId: string): BaseEvent & { threadId: string; runId: string } {
  return { type: AgUiEventType.RUN_FINISHED, timestamp: Date.now(), threadId, runId };
}

export function runError(message: string): BaseEvent & { message: string } {
  return { type: AgUiEventType.RUN_ERROR, timestamp: Date.now(), message };
}

/** Format an event as an SSE data line */
export function sseLine(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
