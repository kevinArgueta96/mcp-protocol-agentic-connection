import type { AgentCard, AgentSkill } from "../types/a2a.js";
import type { ProjectInfo } from "./project-detector.js";
interface CardOptions {
    agentId: string;
    port: number;
    projectInfo: ProjectInfo;
    skills: AgentSkill[];
}
export declare function generateAgentCard(options: CardOptions): AgentCard;
export {};
//# sourceMappingURL=card.d.ts.map