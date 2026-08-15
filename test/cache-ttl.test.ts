import { describe, expect, it } from "vitest";

import { DEFAULT_ASSUMPTIONS, cacheWriteMultiplierFor, estimate } from "../src/estimate.js";
import type { Assumptions } from "../src/estimate.js";
import { read } from "../src/spec.js";

/**
 * A cache write is billed by how long the entry lives.
 *
 * This was a real defect: a single 1.25x multiplier is right for the API's
 * five-minute default and about a third light for the one-hour tier. It was
 * found by localflow, which prices real Claude Code sessions and can check its
 * arithmetic against the `total_cost_usd` the CLI reports for a run it just did.
 * On that oracle 1.25x missed and 2.0x matched to ten decimal places.
 */
const spec = read(
  "cached.graph.json",
  JSON.stringify({
    name: "mostly-cached",
    nodes: [{ id: "inspect", kind: "fan-out", tier: "standard", fanout: { over: "files", width: 50 } }],
    edges: [],
  }),
);

const withTtl = (ttl: "5m" | "1h"): Partial<Assumptions> => ({
  cacheTtl: ttl,
  // A profile that is nearly all shared prefix, which is what a real agent
  // workflow looks like and where the multiplier actually bites.
  profiles: { ...DEFAULT_ASSUMPTIONS.profiles, worker: { input: 100_000, output: 500, cacheHitRate: 0.95 } },
});

describe("cache writes are billed by TTL", () => {
  it("defaults to the five-minute rate, which is the API default", () => {
    expect(DEFAULT_ASSUMPTIONS.cacheTtl).toBe("5m");
    expect(cacheWriteMultiplierFor({ ...DEFAULT_ASSUMPTIONS, asOf: "2026-08-16" })).toBe(1.25);
  });

  it("uses the one-hour rate when the graph says so", () => {
    expect(cacheWriteMultiplierFor({ ...DEFAULT_ASSUMPTIONS, asOf: "2026-08-16", cacheTtl: "1h" })).toBe(2.0);
  });

  it("prices a one-hour run above a five-minute one", () => {
    const short = estimate(spec, withTtl("5m"));
    const long = estimate(spec, withTtl("1h"));
    expect(long.usd.expected).toBeGreaterThan(short.usd.expected);
  });

  it("still honours a legacy single-value override rather than changing someone's price silently", () => {
    // An existing preflight.json may set cacheWriteMultiplier. Ignoring it would
    // move a number the user had deliberately pinned.
    const legacy = estimate(spec, { ...withTtl("1h"), cacheWriteMultiplier: 1.25 });
    const short = estimate(spec, withTtl("5m"));
    expect(legacy.usd.expected).toBeCloseTo(short.usd.expected, 10);
  });

  it("states the TTL and the multiplier it used, so the number can be argued with", () => {
    const e = estimate(spec, withTtl("1h"));
    expect(e.assumptions.cacheTtl).toBe("1h");
    expect(cacheWriteMultiplierFor(e.assumptions)).toBe(2.0);
  });
});
