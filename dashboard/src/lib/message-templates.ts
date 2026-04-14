export interface MessageTemplate {
  id: string;
  label: string;
  body: string;
}

export const MESSAGE_TEMPLATES: MessageTemplate[] = [
  {
    id: "ask",
    label: "/ask — question",
    body: "Can you help me with the following?\n\n",
  },
  {
    id: "delegate",
    label: "/delegate — hand off task",
    body: "Please take ownership of the following task and complete it:\n\n",
  },
  {
    id: "review",
    label: "/review — review work",
    body: "Please review the following and share your feedback:\n\n",
  },
  {
    id: "status",
    label: "/status — request update",
    body: "What is the current status of the task you were working on?",
  },
  {
    id: "cancel",
    label: "/cancel — stop task",
    body: "Please stop the current task. No further action is needed.",
  },
];
