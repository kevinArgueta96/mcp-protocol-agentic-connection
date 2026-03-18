import type { ZodSchema } from "zod";
export interface SkillDefinition {
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
    inputSchema: ZodSchema;
    outputSchema?: ZodSchema;
}
export interface SkillContext {
    agentId: string;
    taskId: string;
    projectPath: string;
    log: (level: "info" | "warn" | "error", message: string) => void;
}
export type SkillHandler<TInput, TOutput> = (input: TInput, context: SkillContext) => Promise<TOutput>;
export declare const GRAPH_START: "__start__";
export declare const GRAPH_END: "__end__";
export type StateReducer<T> = "replace" | "append" | ((current: T, update: T) => T);
export type NodeFn<S> = (state: S) => Promise<Partial<S>>;
export interface StateGraphEdge {
    from: string;
    to: string;
}
export interface ConditionalEdge<S> {
    from: string;
    condition: (state: S) => string | string[];
    pathMap?: Record<string, string>;
}
//# sourceMappingURL=skills.d.ts.map