import { describe, it, expect } from "vitest";
import { BoundedIdSet } from "../client/bounded-id-set.js";

/**
 * BoundedIdSet keeps memory predictable for in-process dedup buckets that
 * would otherwise grow unbounded across the lifetime of a long-running daemon.
 */
describe("BoundedIdSet", () => {
  it("behaves like a Set for has/add/delete within capacity", () => {
    const set = new BoundedIdSet(10);
    set.add("a");
    set.add("b");
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(false);
    expect(set.size).toBe(2);
    expect(set.delete("a")).toBe(true);
    expect(set.has("a")).toBe(false);
  });

  it("evicts the oldest entry when capacity is exceeded", () => {
    const set = new BoundedIdSet(3);
    set.add("a");
    set.add("b");
    set.add("c");
    set.add("d"); // evicts "a"
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
    expect(set.has("d")).toBe(true);
    expect(set.size).toBe(3);
  });

  it("does not re-insert (or evict) on duplicate add", () => {
    const set = new BoundedIdSet(2);
    set.add("a");
    set.add("b");
    set.add("a"); // no-op; should NOT evict "a" itself
    set.add("c"); // should evict the oldest, which is still "a"
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  it("clear() empties the set", () => {
    const set = new BoundedIdSet(5);
    set.add("a");
    set.add("b");
    set.clear();
    expect(set.size).toBe(0);
    expect(set.has("a")).toBe(false);
  });
});
