// LangGraph-inspired StateGraph for composing skills into flows
// TODO: implement full graph execution engine

import { GRAPH_END, GRAPH_START } from "../types/skills.js";
import type { ConditionalEdge, NodeFn, StateReducer } from "../types/skills.js";

type ReducerMap<S> = { [K in keyof S]?: StateReducer<S[K]> };

export class StateGraph<S extends Record<string, unknown>> {
  private nodes = new Map<string, NodeFn<S>>();
  private edges = new Map<string, string[]>();
  private conditionalEdges: ConditionalEdge<S>[] = [];
  private entryPoint: string | null = null;

  constructor(private readonly reducers: ReducerMap<S> = {}) {}

  addNode(name: string, fn: NodeFn<S>): this {
    if (name === GRAPH_START || name === GRAPH_END) {
      throw new Error(`Reserved node name: ${name}`);
    }
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from: string, to: string): this {
    const existing = this.edges.get(from) ?? [];
    this.edges.set(from, [...existing, to]);
    return this;
  }

  addConditionalEdge(
    from: string,
    condition: (state: S) => string | string[],
    pathMap?: Record<string, string>
  ): this {
    this.conditionalEdges.push({ from, condition, pathMap });
    return this;
  }

  setEntryPoint(name: string): this {
    this.entryPoint = name;
    return this;
  }

  compile(): CompiledGraph<S> {
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
    return new CompiledGraph(
      this.nodes,
      this.edges,
      this.conditionalEdges,
      this.reducers,
      this.entryPoint
    );
  }
}

export class CompiledGraph<S extends Record<string, unknown>> {
  constructor(
    private readonly nodes: Map<string, NodeFn<S>>,
    private readonly edges: Map<string, string[]>,
    private readonly conditionalEdges: ConditionalEdge<S>[],
    private readonly reducers: ReducerMap<S>,
    private readonly entryPoint: string
  ) {}

  async invoke(initialState: Partial<S>): Promise<S> {
    let state = { ...initialState } as S;
    let current = this.entryPoint;

    while (current !== GRAPH_END) {
      const fn = this.nodes.get(current);
      if (!fn) throw new Error(`Node "${current}" not found.`);

      const update = await fn(state);
      state = this.applyReducers(state, update);

      const next = this.resolveNext(current, state);
      if (next.length === 0) break;

      // Fan-out: run parallel nodes and merge
      if (next.length > 1) {
        const updates = await Promise.all(next.map((n) => this.nodes.get(n)!(state)));
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

  async *stream(initialState: Partial<S>): AsyncGenerator<{ node: string; state: S }> {
    let state = { ...initialState } as S;
    let current = this.entryPoint;

    while (current !== GRAPH_END) {
      const fn = this.nodes.get(current);
      if (!fn) throw new Error(`Node "${current}" not found.`);

      const update = await fn(state);
      state = this.applyReducers(state, update);

      yield { node: current, state };

      const next = this.resolveNext(current, state);
      if (next.length === 0) break;
      current = next[0];
    }
  }

  private resolveNext(current: string, state: S): string[] {
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

  private applyReducers(current: S, update: Partial<S>): S {
    const next = { ...current };
    for (const [key, value] of Object.entries(update) as [keyof S, unknown][]) {
      const reducer = this.reducers[key];
      if (!reducer || reducer === "replace") {
        (next as Record<keyof S, unknown>)[key] = value;
      } else if (reducer === "append") {
        const existing = current[key];
        (next as Record<keyof S, unknown>)[key] = Array.isArray(existing)
          ? [...existing, ...(Array.isArray(value) ? value : [value])]
          : value;
      } else {
        (next as Record<keyof S, unknown>)[key] = reducer(current[key], value as S[keyof S]);
      }
    }
    return next;
  }
}
