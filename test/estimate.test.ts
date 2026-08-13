import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classify, DEFAULT_ASSUMPTIONS, diffEstimates, estimate } from "../src/estimate.js";
import { PRICING, PRICING_VERIFIED, priceOf, pricingAgeDays, resolveModel } from "../src/pricing.js";
import { markdown } from "../src/report.js";
import { read, readScript, readSpec } from "../src/spec.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fx = (n: string) => readFileSync(join(FIXTURES, n), "utf8");

describe("pricing", () => {
  it("knows the current model line-up", () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"]) {
      expect(PRICING[m], m).toBeDefined();
    }
  });

  it("prices the tiers in the right order", () => {
    expect(PRICING["claude-haiku-4-5"]!.input).toBeLessThan(PRICING["claude-sonnet-5"]!.input);
    expect(PRICING["claude-sonnet-5"]!.input).toBeLessThan(PRICING["claude-opus-5"]!.input);
    expect(PRICING["claude-opus-5"]!.input).toBeLessThan(PRICING["claude-fable-5"]!.input);
  });

  it("output always costs more than input", () => {
    for (const [id, p] of Object.entries(PRICING)) {
      expect(p.output, id).toBeGreaterThan(p.input);
    }
  });

  it("resolves aliases and partial names", () => {
    expect(resolveModel("opus")).toBe("claude-opus-5");
    expect(resolveModel("sonnet")).toBe("claude-sonnet-5");
    expect(resolveModel("haiku")).toBe("claude-haiku-4-5");
    expect(resolveModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveModel("fable")).toBe("claude-fable-5");
  });

  it("prefers the longest match so a versioned id is not swallowed by an alias", () => {
    expect(resolveModel("claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  it("assumes the session model — the deep tier — when none is set", () => {
    // Assuming cheap here would make every unfixed graph look free.
    expect(resolveModel(null)).toBe("claude-opus-5");
    expect(priceOf(null).tier).toBe("deep");
  });

  it("applies introductory pricing inside the window and standard pricing after", () => {
    const intro = priceOf("claude-sonnet-5", "2026-08-01");
    const after = priceOf("claude-sonnet-5", "2026-09-01");
    expect(intro.input).toBe(2);
    expect(intro.output).toBe(10);
    expect(after.input).toBe(3);
    expect(after.output).toBe(15);
  });

  it("states when the table was verified", () => {
    expect(PRICING_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pricingAgeDays("2026-06-24")).toBe(0);
    expect(pricingAgeDays("2026-07-24")).toBe(30);
  });
});

describe("reading a declarative spec", () => {
  const spec = readSpec(fx("audit.graph.json"));

  it("reads the name, budget and node tiers", () => {
    expect(spec.name).toBe("route-auth-audit");
    expect(spec.budget).toEqual({ tokens: 2_000_000, usd: 12 });
    expect(spec.nodes.map((n) => n.id)).toEqual(["scope", "inspect", "verify", "report"]);
  });

  it("reads a declared fan-out width rather than assuming one", () => {
    expect(spec.nodes.find((n) => n.id === "inspect")!.fanout).toBe(40);
  });

  it("reads the verifier lens count", () => {
    expect(spec.nodes.find((n) => n.id === "verify")!.lenses).toHaveLength(3);
  });

  it("marks the terminal node", () => {
    expect(spec.nodes.find((n) => n.id === "report")!.terminal).toBe(true);
    expect(spec.nodes.find((n) => n.id === "scope")!.terminal).toBe(false);
  });

  it("finds no cycle in a linear spec", () => {
    expect(spec.hasCycle).toBe(false);
  });

  it("detects a back edge as a cycle", () => {
    const cyclic = readSpec(
      JSON.stringify({
        name: "loop",
        nodes: [{ id: "a" }, { id: "b" }],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      }),
    );
    expect(cyclic.hasCycle).toBe(true);
    expect(cyclic.nodes.every((n) => n.inCycle)).toBe(true);
  });

  it("uses a declared round cap when present", () => {
    const capped = readSpec(
      JSON.stringify({
        name: "loop",
        nodes: [{ id: "a", loop: { maxRounds: 6 } }, { id: "b" }],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      }),
    );
    expect(capped.cycleRounds).toEqual({ low: 1, expected: 3, high: 6 });
  });

  it("warns when a node fans out with no declared width", () => {
    const vague = readSpec(
      JSON.stringify({ name: "x", nodes: [{ id: "a", fanout: { over: "files" } }], edges: [] }),
    );
    expect(vague.nodes[0]!.fanout).toBe(-1);
    expect(vague.warnings.join(" ")).toMatch(/states no width/);
  });
});

describe("classify", () => {
  const node = (over: Partial<Parameters<typeof classify>[0]>) =>
    classify({
      id: "x",
      tier: null,
      model: null,
      fanout: null,
      lenses: [],
      isVerifier: false,
      inCycle: false,
      terminal: false,
      ...over,
    });

  it("calls a lensed node a verifier", () => {
    expect(node({ lenses: ["a", "b"] })).toBe("verifier");
    expect(node({ isVerifier: true })).toBe("verifier");
  });

  it("recognises scope nodes by name", () => {
    expect(node({ id: "scope" })).toBe("scope");
    expect(node({ id: "enumerate-routes" })).toBe("scope");
  });

  it("recognises synthesis nodes by name", () => {
    expect(node({ id: "report" })).toBe("synthesis");
    expect(node({ id: "write-summary" })).toBe("synthesis");
  });

  it("treats a terminal unnamed node as synthesis", () => {
    expect(node({ id: "final", terminal: true })).toBe("synthesis");
  });

  it("treats a fanned-out node as a worker", () => {
    expect(node({ id: "inspect", fanout: 40 })).toBe("worker");
  });
});

describe("estimate", () => {
  const e = estimate(readSpec(fx("audit.graph.json")), { asOf: "2026-08-01" });

  it("prices every node", () => {
    expect(e.nodes).toHaveLength(4);
    for (const n of e.nodes) expect(n.usd.expected).toBeGreaterThan(0);
  });

  it("produces a range, not a point", () => {
    expect(e.usd.low).toBeLessThan(e.usd.expected);
    expect(e.usd.expected).toBeLessThan(e.usd.high);
    expect(e.agents.low).toBeLessThan(e.agents.high);
  });

  it("identifies verification as the largest stage", () => {
    // findings x lenses is the growth term, not fan-out width — the whole point.
    const largest = Object.entries(e.byKind).sort((a, b) => b[1] - a[1])[0]!;
    expect(largest[0]).toBe("verifier");
  });

  it("scales the verifier term with the lens count", () => {
    const spec = readSpec(fx("audit.graph.json"));
    const oneLens = JSON.parse(fx("audit.graph.json"));
    oneLens.nodes.find((n: any) => n.id === "verify").harness.lenses = ["authz"];
    const cheaper = estimate(readSpec(JSON.stringify(oneLens)), { asOf: "2026-08-01" });
    expect(cheaper.byKind.verifier).toBeLessThan(estimate(spec, { asOf: "2026-08-01" }).byKind.verifier);
  });

  it("costs a deep-tier graph more than a tiered one", () => {
    const tiered = estimate(readSpec(fx("audit.graph.json")), { asOf: "2026-08-01" });
    const allDeep = estimate(readSpec(fx("expensive.graph.json")), { asOf: "2026-08-01" });
    expect(allDeep.usd.expected).toBeGreaterThan(tiered.usd.expected);
  });

  it("respects the declared budget and reports the overrun", () => {
    expect(e.budget!.usd).toBe(12);
    expect(e.budget!.overBy).toBeLessThan(0); // under budget
    const tiny = JSON.parse(fx("audit.graph.json"));
    tiny.budget.usd = 0.1;
    const over = estimate(readSpec(JSON.stringify(tiny)), { asOf: "2026-08-01" });
    expect(over.budget!.overBy).toBeGreaterThan(0);
    expect(over.warnings.join(" ")).toMatch(/exceeds the declared budget/);
  });

  it("ranks levers with the most expensive first", () => {
    for (let i = 1; i < e.drivers.length; i++) {
      expect(e.drivers[i]!.usd).toBeLessThanOrEqual(e.drivers[i - 1]!.usd);
    }
    expect(e.drivers[0]!.lever.length).toBeGreaterThan(10);
  });

  it("names its assumptions in the output", () => {
    expect(e.assumptions.profiles.worker.input).toBeGreaterThan(0);
    expect(e.assumptions.findingsPerWorker.expected).toBeGreaterThan(0);
    expect(e.pricingVerified).toBe(PRICING_VERIFIED);
  });

  it("lets assumptions be overridden", () => {
    const spec = readSpec(fx("audit.graph.json"));
    const fat = estimate(spec, {
      asOf: "2026-08-01",
      profiles: { ...DEFAULT_ASSUMPTIONS.profiles, worker: { input: 80_000, output: 800, cacheHitRate: 0 } },
    });
    const thin = estimate(spec, { asOf: "2026-08-01" });
    expect(fat.byKind.worker).toBeGreaterThan(thin.byKind.worker);
  });

  it("charges more when the prompt cache cannot be used", () => {
    const spec = readSpec(fx("audit.graph.json"));
    const cached = estimate(spec, { asOf: "2026-08-01" });
    const uncached = estimate(spec, {
      asOf: "2026-08-01",
      profiles: {
        ...DEFAULT_ASSUMPTIONS.profiles,
        worker: { ...DEFAULT_ASSUMPTIONS.profiles.worker, cacheHitRate: 0 },
      },
    });
    expect(uncached.byKind.worker).toBeGreaterThan(cached.byKind.worker);
  });

  it("multiplies a cycle by its round count", () => {
    const base = {
      name: "loop",
      nodes: [
        { id: "find", tier: "cheap", fanout: { width: 4 } },
        { id: "rank", tier: "deep" },
      ],
      edges: [
        { from: "find", to: "rank" },
        { from: "rank", to: "find" },
      ],
    };
    const uncapped = estimate(readSpec(JSON.stringify(base)), { asOf: "2026-08-01" });
    const capped = estimate(
      readSpec(JSON.stringify({ ...base, nodes: [{ ...base.nodes[0], loop: { maxRounds: 2 } }, base.nodes[1]] })),
      { asOf: "2026-08-01" },
    );
    expect(uncapped.usd.high).toBeGreaterThan(capped.usd.high);
    expect(uncapped.warnings.join(" ")).toMatch(/no declared round cap/);
  });

  it("warns about an untiered node and prices it as the session model", () => {
    const untiered = estimate(
      readSpec(JSON.stringify({ name: "x", nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] })),
      { asOf: "2026-08-01" },
    );
    expect(untiered.warnings.join(" ")).toMatch(/inherits the session model/);
    expect(untiered.nodes.every((n) => n.model === "claude-opus-5")).toBe(true);
  });

  it("prices a verify-only spec from its declared width, not from absent workers", () => {
    // Regression: authsweep emits a graph that STARTS at the verify stage. With
    // no upstream workers the derived finding count is zero, so the whole stage
    // priced at nothing. An explicit fanout.width is a real count and must win.
    const verifyOnly = estimate(
      readSpec(
        JSON.stringify({
          name: "authsweep-verify",
          nodes: [
            {
              id: "verify", tier: "standard", outputSchema: "VERDICT",
              fanout: { over: "findings", width: 8 },
              harness: { kind: "diverse-lens", lenses: ["authz", "input", "session"] },
            },
            { id: "report", tier: "deep" },
          ],
          edges: [{ from: "verify", to: "report", channel: "confirmed", barrier: true, barrierReason: "ranks against each other" }],
        }),
      ),
      { asOf: "2026-08-01" },
    );
    const v = verifyOnly.nodes.find((n) => n.id === "verify")!;
    expect(v.calls.expected).toBe(24); // 8 findings x 3 lenses
    expect(v.usd.expected).toBeGreaterThan(0);
    expect(v.widthAssumed).toBe(false);
    expect(verifyOnly.byKind.verifier).toBeGreaterThan(0);
  });

  it("warns when a verifier has neither upstream workers nor a declared width", () => {
    const orphanVerifier = estimate(
      readSpec(
        JSON.stringify({
          name: "x",
          nodes: [{ id: "verify", tier: "standard", harness: { lenses: ["a"] } }, { id: "report", tier: "deep" }],
          edges: [{ from: "verify", to: "report" }],
        }),
      ),
      { asOf: "2026-08-01" },
    );
    expect(orphanVerifier.warnings.join(" ")).toMatch(/nothing upstream produces findings/);
  });

  it("flags duplicate verifier lenses", () => {
    const dup = estimate(
      readSpec(
        JSON.stringify({
          name: "x",
          nodes: [
            { id: "scan", tier: "cheap", fanout: { width: 5 } },
            { id: "verify", tier: "standard", harness: { lenses: ["a", "a", "a"] } },
          ],
          edges: [{ from: "scan", to: "verify" }],
        }),
      ),
      { asOf: "2026-08-01" },
    );
    expect(dup.warnings.join(" ")).toMatch(/duplicate lenses/);
  });
});

describe("reading a script", () => {
  const SCRIPT = `
    export const meta = { name: "review", description: "d", budget: { usd: 5 } }
    const LENSES = ["correctness", "security", "repro"]
    await parallel([() => agent("scan a", { model: "claude-haiku-4-5" }), () => agent("scan b", { model: "claude-haiku-4-5" })])
    await agent("Verify this finding is real", { model: "claude-sonnet-5" })
    await agent("Write the report", { model: "claude-opus-5" })
  `;

  it("recovers nodes, models and the literal fan-out width", () => {
    const s = readScript(SCRIPT);
    expect(s.kind).toBe("script");
    expect(s.name).toBe("review");
    expect(s.budget!.usd).toBe(5);
    expect(s.nodes.length).toBe(4);
    expect(s.nodes[0]!.fanout).toBe(2);
  });

  it("marks a verifier and picks up the lens array", () => {
    const s = readScript(SCRIPT);
    const v = s.nodes.find((n) => n.isVerifier)!;
    expect(v.lenses).toHaveLength(3);
  });

  it("says plainly that a script estimate is looser", () => {
    expect(readScript(SCRIPT).warnings.join(" ")).toMatch(/declarative spec are far tighter/);
  });

  it("reads Array.from length as a width", () => {
    const s = readScript('await parallel(Array.from({ length: 7 }, () => () => agent("x")))');
    expect(s.nodes[0]!.fanout).toBe(7);
  });

  it("finds a cycle and its cap", () => {
    const s = readScript(`
      let rounds = 0
      while (rounds < 4) { rounds++; await agent("find more") }
    `);
    expect(s.hasCycle).toBe(true);
    expect(s.cycleRounds).toEqual({ low: 1, expected: 2, high: 4 });
  });

  it("throws a readable error on an unparseable script", () => {
    expect(() => readScript("const = = =")).toThrow(/cannot parse script/);
  });

  it("dispatches on file extension", () => {
    expect(read("a.graph.json", fx("audit.graph.json")).kind).toBe("spec");
    expect(read("a.js", 'await agent("x")').kind).toBe("script");
  });
});

describe("diff and the PR comment", () => {
  const before = estimate(readSpec(fx("audit.graph.json")), { asOf: "2026-08-01" });
  const after = estimate(readSpec(fx("expensive.graph.json")), { asOf: "2026-08-01" });

  it("reports the delta in both directions", () => {
    const up = diffEstimates(before, after);
    expect(up.usdDelta).toBeGreaterThan(0);
    const down = diffEstimates(after, before);
    expect(down.usdDelta).toBeLessThan(0);
  });

  it("handles a spec that is new in this PR", () => {
    const d = diffEstimates(null, after);
    expect(d.usdDelta).toBeNull();
    expect(d.changes).toEqual([]);
  });

  it("lists nodes that were added, removed or repriced", () => {
    const trimmed = JSON.parse(fx("audit.graph.json"));
    trimmed.nodes = trimmed.nodes.filter((n: any) => n.id !== "verify");
    trimmed.edges = trimmed.edges.filter((e: any) => e.from !== "verify" && e.to !== "verify");
    const d = diffEstimates(before, estimate(readSpec(JSON.stringify(trimmed)), { asOf: "2026-08-01" }));
    expect(d.changes.some((c) => c.id === "verify" && c.kind === "removed")).toBe(true);
  });

  it("emits a comment with a stable marker so it updates instead of duplicating", () => {
    const md = markdown(diffEstimates(before, after), { file: "audit.graph.json" });
    expect(md).toContain("<!-- preflight-cost -->");
    expect(md).toMatch(/### Predicted cost/);
    expect(md).toMatch(/\| \*\*expected\*\* \|/);
    expect(md).toMatch(/this is an estimate, not a quote/);
  });

  it("warns in the comment when the budget is blown", () => {
    const tiny = JSON.parse(fx("audit.graph.json"));
    tiny.budget.usd = 0.05;
    const md = markdown(
      diffEstimates(null, estimate(readSpec(JSON.stringify(tiny)), { asOf: "2026-08-01" })),
      { file: "x" },
    );
    expect(md).toMatch(/\[!WARNING\]/);
    expect(md).toMatch(/exceeds the declared budget/);
  });

  it("marks assumed counts with a tilde so nobody reads them as measured", () => {
    const md = markdown(diffEstimates(null, before), { file: "x" });
    expect(md).toContain("~");
    expect(md).toMatch(/assumed rather than read from the spec/);
  });
});
