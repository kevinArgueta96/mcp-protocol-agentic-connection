// Registry EventBus — typed event emitter for real-time dashboard updates
import { EventEmitter } from "node:events";

export type RegistryEventType =
  | "agent.registered"
  | "agent.deregistered"
  | "agent.heartbeat"
  | "agent.unhealthy"
  | "agent.removed"
  | "task.update"
  | "agent.message"
  | "claude.notify"
  | "channel.message"
  | "channel.ack"
  | "channel.conversation.suppressed"
  | "channel.conversation.revived";

export interface RegistryEvent {
  type: RegistryEventType;
  timestamp: string;
  data: unknown;
}

export class RegistryEventBus extends EventEmitter {
  broadcast(event: RegistryEvent): void {
    this.emit("event", event);
  }
}
