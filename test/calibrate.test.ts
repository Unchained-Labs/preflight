import { describe, expect, it } from "vitest";

import { calibrate, DEFAULT_KIND, MIN_SAMPLES, mergeConfig, parseUsage, readRecord } from "../src/calibrate.js";
import { DEFAULT_ASSUMPTIONS, estimate } from "../src/estimate.js";
import { read } from "../src/spec.js";

/**
 * A row exactly as Otter serialises it — `otter-core/src/domain.rs::JobUsage`,
 * snake_case, `estimated_cost_usd` nullable because cost is derived and Otter
 * reports `None` rather than zero when it has no price for the model.
 */
const otterRow = (prompt: number, completion: number, model: string | null = "claude-opus-5") => ({
  job_id: "3f2a1e88-0000-0000-0000-000000000000",
  model,
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  estimated_cost_usd: model ? 0.12 : null,
  duration_ms: 41_000,
  created_at: "2026-08-14T10:00:00Z",
});

const otterRows = (pairs: [number, number][]) => pairs.map(([p, c]) => otterRow(p, c));

/**
 * Raw Otter rows through the real parse path, which is how the CLI reaches
 * `calibrate`. Handing `calibrate` hand-built records instead would test a shape
 * nothing actually produces.
 */
const rows = (pairs: [number, number][]) => parseUsage(JSON.stringify(otterRows(pairs))).records;
const normalise = (raw: unknown[]) => parseUsage(JSON.stringify(raw)).records;

describe("reading Otter's usage shape", () => {
  it("reads the snake_case Otter actually emits", () => {
    const r = readRecord(otterRow(12_000, 900));
    expect(r).toEqual({
      model: "claude-opus-5",
      promptTokens: 12_000,
      completionTokens: 900,
      costUsd: 0.12,
      durationMs: 41_000,
    });
  });

  it("also reads camelCase, because consumers reshape", () => {
    const r = readRecord({ promptTokens: 500, completionTokens: 50 });
    expect(r?.promptTokens).toBe(500);
  });

  it("rejects a row with no token counts rather than reading it as zero", () => {
    // A row we cannot understand must not become a 0-token sample dragging the
    // median down. It is skipped and counted as malformed.
    expect(readRecord({ job_id: "x", model: "y" })).toBeNull();
    expect(readRecord({ prompt_tokens: -5, completion_tokens: 1 })).toBeNull();
    expect(readRecord(null)).toBeNull();
    expect(readRecord("nope")).toBeNull();
  });

  it.each([
    ["a JSON array", (r: unknown[]) => JSON.stringify(r)],
    ["JSONL", (r: unknown[]) => r.map((x) => JSON.stringify(x)).join("\n")],
    ["a wrapped list", (r: unknown[]) => JSON.stringify({ usage: r })],
  ])("parses %s", (_label, render) => {
    const { records, malformed } = parseUsage(render(otterRows([[1000, 100], [2000, 200]])));
    expect(records).toHaveLength(2);
    expect(malformed).toBe(0);
  });

  it("parses a single object, which is what one curl returns", () => {
    const { records } = parseUsage(JSON.stringify(otterRow(1000, 100)));
    expect(records).toHaveLength(1);
  });

  it("counts unreadable JSONL lines instead of failing the run", () => {
    const { records, malformed } = parseUsage(
      `${JSON.stringify(otterRow(1000, 100))}\nnot json\n${JSON.stringify({ nope: 1 })}`,
    );
    expect(records).toHaveLength(1);
    expect(malformed).toBe(2);
  });

  it("returns nothing for empty input rather than an empty profile", () => {
    expect(parseUsage("   ").records).toEqual([]);
  });
});

describe("calibrating a profile", () => {
  // Deliberately skewed: one run with a huge context, which is what real token
  // distributions look like.
  const skewed = rows([
    [1_000, 100], [1_100, 110], [1_200, 120], [1_300, 130],
    [1_400, 140], [1_500, 150], [400_000, 200],
  ]);

  it("uses the median, so one long run cannot set the profile", () => {
    const cal = calibrate(skewed);
    expect(cal.after.input).toBe(1_300);
    // The mean is dragged far above anything typical — that is the whole reason.
    expect(cal.stats.input.mean).toBeGreaterThan(50_000);
    expect(cal.after.input).toBeLessThan(cal.stats.input.mean);
  });

  it("reports the spread separately, because the tail is what blows a budget", () => {
    const cal = calibrate(skewed);
    expect(cal.stats.input.p90).toBe(400_000);
    expect(cal.stats.input.p10).toBe(1_000);
  });

  it("never invents a cache hit rate", () => {
    // Nothing in a usage row measures cache reads. Deriving one would be the
    // single most tempting lie this command could tell, since it changes the
    // cost materially and nobody would check.
    const cal = calibrate(skewed);
    expect(cal.after.cacheHitRate).toBe(DEFAULT_ASSUMPTIONS.profiles.worker.cacheHitRate);
  });

  it("carries through a cache hit rate the caller had already overridden", () => {
    const cal = calibrate(skewed, {
      current: { profiles: { ...DEFAULT_ASSUMPTIONS.profiles, worker: { input: 1, output: 1, cacheHitRate: 0.42 } } },
    });
    expect(cal.after.cacheHitRate).toBe(0.42);
    expect(cal.before.input).toBe(1);
  });

  it("targets the worker profile by default and says so in the result", () => {
    expect(calibrate(skewed).kind).toBe("worker");
    expect(DEFAULT_KIND).toBe("worker");
  });

  it("writes to whichever kind is named, since the data cannot tell them apart", () => {
    const cal = calibrate(skewed, { kind: "verifier" });
    expect(cal.kind).toBe("verifier");
    expect(cal.before).toEqual(DEFAULT_ASSUMPTIONS.profiles.verifier);
  });

  it("drops zero-token rows and counts them", () => {
    const cal = calibrate(
      normalise([...otterRows([[1000, 100], [1000, 100], [1000, 100], [1000, 100], [1000, 100]]), otterRow(0, 0)]),
    );
    expect(cal.stats.n).toBe(5);
    expect(cal.stats.skipped.zero).toBe(1);
  });

  it("refuses to calibrate from too few samples, and writes nothing", () => {
    const cal = calibrate(rows([[1000, 100], [2000, 200]]));
    expect(cal.refusal).toBeDefined();
    expect(cal.refusal).toMatch(/authority of a measurement/);
    expect(cal.stats.n).toBeLessThan(MIN_SAMPLES);
  });

  it("does not refuse once the sample is large enough", () => {
    expect(calibrate(rows(Array.from({ length: MIN_SAMPLES }, () => [1000, 100] as [number, number]))).refusal)
      .toBeUndefined();
  });

  it("names the models in the sample, so a one-model profile is visible", () => {
    const cal = calibrate(
      normalise([
        ...otterRows([[1000, 100], [1000, 100], [1000, 100], [1000, 100]]),
        otterRow(1000, 100, "claude-haiku-4-5"),
        otterRow(1000, 100, null),
      ]),
    );
    expect(cal.stats.byModel[0]).toEqual({ model: "claude-opus-5", n: 4 });
    expect(cal.stats.byModel.map((m) => m.model)).toContain("(unreported)");
  });
});

describe("writing the config", () => {
  const cal = calibrate(rows(Array.from({ length: 6 }, () => [9_000, 700] as [number, number])));
  const meta = { source: "otter-usage.json", date: "2026-08-14" };

  it("merges rather than replacing, so unrelated overrides survive", () => {
    // A real preflight.json also carries fan-out assumptions and an asOf.
    // Clobbering them would be a silent regression in someone's cost model.
    const merged = mergeConfig(
      { schemaRetryRate: 0.2, unknownFanout: { low: 1, expected: 2, high: 3 } },
      cal,
      meta,
    );
    expect(merged.schemaRetryRate).toBe(0.2);
    expect(merged.unknownFanout).toEqual({ low: 1, expected: 2, high: 3 });
    expect((merged.profiles as any).worker).toEqual({ input: 9_000, output: 700, cacheHitRate: 0.7 });
  });

  it("leaves the other profiles alone", () => {
    const merged = mergeConfig(
      { profiles: { ...DEFAULT_ASSUMPTIONS.profiles, verifier: { input: 11, output: 22, cacheHitRate: 0.5 } } },
      cal,
      meta,
    );
    expect((merged.profiles as any).verifier).toEqual({ input: 11, output: 22, cacheHitRate: 0.5 });
  });

  it("records provenance, including that the cache rate was not measured", () => {
    const c = (mergeConfig({}, cal, meta).$calibration as any).worker;
    expect(c.samples).toBe(6);
    expect(c.source).toBe("otter-usage.json");
    expect(c.calibratedOn).toBe("2026-08-14");
    expect(c.cacheHitRate).toMatch(/not measured/);
    expect(c.inputTokens).toEqual({ p10: 9_000, median: 9_000, p90: 9_000 });
  });

  it("keeps provenance for kinds calibrated earlier", () => {
    const first = mergeConfig({}, calibrate(rows(Array.from({ length: 6 }, () => [1, 1] as [number, number])), { kind: "verifier" }), meta);
    const second = mergeConfig(first, cal, meta);
    expect(Object.keys(second.$calibration as object).sort()).toEqual(["verifier", "worker"]);
  });

  it("produces a config that estimate actually honours", () => {
    // The round trip is the point: measured usage in, a different number out.
    // If the emitted shape did not match what `estimate` reads, the whole
    // command would be a no-op that looked like it worked.
    const spec = read("audit.graph.json", JSON.stringify({
      name: "round-trip",
      nodes: [{ id: "inspect", kind: "fan-out", tier: "cheap", fanout: { over: "files", width: 10 } }],
      edges: [],
    }));
    const plain = estimate(spec, {});
    const merged = mergeConfig({}, cal, meta) as any;
    const tuned = estimate(spec, merged);
    expect(tuned.tokens.input).not.toBe(plain.tokens.input);
    // 9k measured against the 8k default: more input, and the report should say
    // so rather than silently keeping the old figure.
    expect(tuned.tokens.input).toBeGreaterThan(plain.tokens.input);
    expect(tuned.assumptions.profiles.worker.input).toBe(9_000);
  });
});
