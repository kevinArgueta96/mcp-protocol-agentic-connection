// LangGraph-inspired StateGraph for composing skills into flows
// TODO: implement full graph execution engine
import { GRAPH_END, GRAPH_START } from "../types/skills.js";
export class StateGraph {
    reducers;
    nodes = new Map();
    edges = new Map();
    conditionalEdges = [];
    entryPoint = null;
    constructor(reducers = {}) {
        this.reducers = reducers;
    }
    addNode(name, fn) {
        if (name === GRAPH_START || name === GRAPH_END) {
            throw new Error(`Reserved node name: ${name}`);
        }
        this.nodes.set(name, fn);
        return this;
    }
    addEdge(from, to) {
        const existing = this.edges.get(from) ?? [];
        this.edges.set(from, [...existing, to]);
        return this;
    }
    addConditionalEdge(from, condition, pathMap) {
        this.conditionalEdges.push({ from, condition, pathMap });
        return this;
    }
    setEntryPoint(name) {
        this.entryPoint = name;
        return this;
    }
    compile() {
        if (!this.entryPoint) {
            throw new Error("Entry point not set. Call setEntryPoint() before compile().");
        }
        // Validate all edge targets exist
        for (const [from, targets] of this.edges) {
            for (const to of targets) {
                if (to !== GRAPH_END && !this.nodes.has(to)) {
                    throw new Error(`Edge target "${to}" from "${from}" does not exist.`);
                }
            }
        }
        return new CompiledGraph(this.nodes, this.edges, this.conditionalEdges, this.reducers, this.entryPoint);
    }
}
export class CompiledGraph {
    nodes;
    edges;
    conditionalEdges;
    reducers;
    entryPoint;
    constructor(nodes, edges, conditionalEdges, reducers, entryPoint) {
        this.nodes = nodes;
        this.edges = edges;
        this.conditionalEdges = conditionalEdges;
        this.reducers = reducers;
        this.entryPoint = entryPoint;
    }
    async invoke(initialState) {
        let state = { ...initialState };
        let current = this.entryPoint;
        while (current !== GRAPH_END) {
            const fn = this.nodes.get(current);
            if (!fn)
                throw new Error(`Node "${current}" not found.`);
            const update = await fn(state);
            state = this.applyReducers(state, update);
            const next = this.resolveNext(current, state);
            if (next.length === 0)
                break;
            // Fan-out: run parallel nodes and merge
            if (next.length > 1) {
                const updates = await Promise.all(next.map((n) => this.nodes.get(n)(state)));
                for (const u of updates) {
                    state = this.applyReducers(state, u);
                }
                // After fan-out we need explicit convergence edge — for now break
                break;
            }
            current = next[0];
        }
        return state;
    }
    async *stream(initialState) {
        let state = { ...initialState };
        let current = this.entryPoint;
        while (current !== GRAPH_END) {
            const fn = this.nodes.get(current);
            if (!fn)
                throw new Error(`Node "${current}" not found.`);
            const update = await fn(state);
            state = this.applyReducers(state, update);
            yield { node: current, state };
            const next = this.resolveNext(current, state);
            if (next.length === 0)
                break;
            current = next[0];
        }
    }
    resolveNext(current, state) {
        // Check conditional edges first
        const conditional = this.conditionalEdges.find((e) => e.from === current);
        if (conditional) {
            const result = conditional.condition(state);
            const targets = Array.isArray(result) ? result : [result];
            return targets.map((t) => conditional.pathMap?.[t] ?? t);
        }
        // Fall back to normal edges
        return this.edges.get(current) ?? [];
    }
    applyReducers(current, update) {
        const next = { ...current };
        for (const [key, value] of Object.entries(update)) {
            const reducer = this.reducers[key];
            if (!reducer || reducer === "replace") {
                next[key] = value;
            }
            else if (reducer === "append") {
                const existing = current[key];
                next[key] = Array.isArray(existing)
                    ? [...existing, ...(Array.isArray(value) ? value : [value])]
                    : value;
            }
            else {
                next[key] = reducer(current[key], value);
            }
        }
        return next;
    }
}
//# sourceMappingURL=state-graph.js.map