export type ProjectType = "node" | "rust" | "go" | "python" | "java" | "unknown";
export interface ProjectInfo {
    type: ProjectType;
    name: string;
    rootDir: string;
    configFile?: string;
    version?: string;
}
export declare function detectProjectType(dir: string): Promise<ProjectInfo>;
//# sourceMappingURL=project-detector.d.ts.map