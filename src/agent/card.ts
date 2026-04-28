// Generate AgentCard from project context
import type { AgentCard, AgentSkill } from "../types/a2a.js";
import type { ProjectInfo } from "./project-detector.js";

interface CardOptions {
  agentId: string;
  port: number;
  projectInfo: ProjectInfo;
  skills: AgentSkill[];
}

export function generateAgentCard(options: CardOptions): AgentCard {
  const { agentId, port, projectInfo, skills } = options;
  const url = `http://localhost:${port}`;

  return {
    name: projectInfo.name,
    description: `Agent for ${projectInfo.type} project at ${projectInfo.rootDir}`,
    url,
    version: "0.1.0",
    provider: {
      organization: "open-agent-bridge",
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills,
    // Store extra local metadata in a custom extension field
    ...({
      "x-open-agent-bridge": {
        agentId,
        projectPath: projectInfo.rootDir,
        projectType: projectInfo.type,
        wsUrl: `ws://localhost:${port}/ws`,
      },
    } as unknown as Partial<AgentCard>),
  };
}
