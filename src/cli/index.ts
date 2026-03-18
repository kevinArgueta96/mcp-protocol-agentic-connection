#!/usr/bin/env node
import { Command } from "commander";
import { registerStartCommand } from "./commands/start.js";
import { registerRegistryCommand } from "./commands/registry.js";
import { registerListCommand } from "./commands/list.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerAskCommand } from "./commands/ask.js";
import { registerFindCommand } from "./commands/find.js";
import { registerDelegateCommand } from "./commands/delegate.js";
import { registerBroadcastCommand } from "./commands/broadcast.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerDashboardCommand } from "./commands/dashboard.js";

const program = new Command();

program
  .name("agent-bridge")
  .description("Local agent communication protocol — A2A + MCP + WebSocket")
  .version("0.1.0");

registerStartCommand(program);
registerRegistryCommand(program);
registerListCommand(program);
registerHealthCommand(program);
registerAskCommand(program);
registerFindCommand(program);
registerDelegateCommand(program);
registerBroadcastCommand(program);
registerMcpCommand(program);
registerDashboardCommand(program);

program.parse(process.argv);
