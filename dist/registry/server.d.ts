export declare class RegistryServer {
    private readonly port;
    private store;
    private app;
    private server;
    private healthCheckTimer;
    constructor(port?: number);
    private setupRoutes;
    start(): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=server.d.ts.map