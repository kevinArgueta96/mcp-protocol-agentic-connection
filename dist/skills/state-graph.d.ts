import type { ConditionalEdge, NodeFn, StateReducer } from "../types/skills.js";
type ReducerMap<S> = {
    [K in keyof S]?: StateReducer<S[K]>;
};
export declare class StateGraph<S extends Record<string, unknown>> {
    private readonly reducers;
    private nodes;
    private edges;
    private conditionalEdges;
    private entryPoint;
    constructor(reducers?: ReducerMap<S>);
    addNode(name: string, fn: NodeFn<S>): this;
    addEdge(from: string, to: string): this;
    addConditionalEdge(from: string, condition: (state: S) => string | string[], pathMap?: Record<string, string>): this;
    setEntryPoint(name: string): this;
    compile(): CompiledGraph<S>;
}
export declare class CompiledGraph<S extends Record<string, unknown>> {
    private readonly nodes;
    private readonly edges;
    private readonly conditionalEdges;
    private readonly reducers;
    private readonly entryPoint;
    constructor(nodes: Map<string, NodeFn<S>>, edges: Map<string, string[]>, conditionalEdges: ConditionalEdge<S>[], reducers: ReducerMap<S>, entryPoint: string);
    invoke(initialState: Partial<S>): Promise<S>;
    stream(initialState: Partial<S>): AsyncGenerator<{
        node: string;
        state: S;
    }>;
    private resolveNext;
    private applyReducers;
}
export {};
//# sourceMappingURL=state-graph.d.ts.map