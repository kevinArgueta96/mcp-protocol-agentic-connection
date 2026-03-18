export function generateAgentCard(options) {
    const { agentId, port, projectInfo, skills } = options;
    const url = `http://localhost:${port}`;
    return {
        name: projectInfo.name,
        description: `Agent for ${projectInfo.type} project at ${projectInfo.rootDir}`,
        url,
        version: "0.1.0",
        provider: {
            organization: "agent-bridge",
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
        ...{
            "x-agent-bridge": {
                agentId,
                projectPath: projectInfo.rootDir,
                projectType: projectInfo.type,
                wsUrl: `ws://localhost:${port}/ws`,
            },
        },
    };
}
//# sourceMappingURL=card.js.map