import type { AgentCard } from "../types/a2a.js";
import type { BaseSkill } from "../skills/framework.js";
export interface AgentServerOptions {
    port?: number;
    projectPath?: string;
    extraSkills?: BaseSkill[];
    registryUrl?: string;
    name?: string;
}
export interface StartResult {
    agentId: string;
    port: number;
    url: string;
    wsUrl: string;
    card: AgentCard;
}
export declare class AgentServer {
    private readonly options;
    private agentId;
    private card;
    private taskStore;
    private router;
    private heartbeatTimer;
    private httpServer;
    private routerCtx;
    constructor(options?: AgentServerOptions);
    start(): Promise<StartResult>;
    stop(): Promise<void>;
    private handleWsConnection;
    private findAvailablePort;
    private isPortFree;
    private registerWithRegistry;
    private sendHeartbeat;
    private deregisterFromRegistry;
}
//# sourceMappingURL=server.d.ts.map