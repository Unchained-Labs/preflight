/**
 * Turn measured token usage into a calibrated `preflight.json`.
 *
 * preflight's documented weakness is that its token profiles are generic. The
 * README has always said: run one real workflow, read the counts out of your
 * spans, put them in `preflight.json`. This is that step, automated for the one
 * system we have that produces exactly those spans — Otter, whose
 * `GET /v1/jobs/{id}/usage` returns normalised `prompt_tokens` /
 * `completion_tokens` per job.
 *
 * The direction of the arrow matters. `preflight models --format otter-env`
 * sends *prices* to Otter, which are a published fact. This sends *measurements*
 * back, which are the thing preflight cannot know on its own. Prices we look up;
 * token counts only your own runs can tell you.
 *
 * Three things this deliberately refuses to do, because a number that looks
 * measured and is not is worse than an assumption that admits it:
 *
 *   1. **It does not invent a cache hit rate.** Otter's `TokenUsage` has no
 *      cache-read field, so there is nothing to derive one from. The existing
 *      `cacheHitRate` is carried through untouched and the report says so.
 *   2. **It does not guess which node kind a job was.** An Otter job is a single
 *      prompt in one workspace; it has no `verifier`/`worker` distinction to
 *      read. You name the kind, and the default is stated rather than implied.
 *   3. **It refuses to calibrate from too few samples.** Two runs produce a
 *      number with the authority of a measurement and the accuracy of a guess.
 */
import { DEFAULT_ASSUMPTIONS } from "./estimate.js";
const NUM = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
/** Pull a usage record out of an object, tolerating either naming convention. */
export function readRecord(o) {
    if (!o || typeof o !== "object")
        return null;
    const r = o;
    const input = NUM(r.promptTokens) ?? NUM(r.prompt_tokens) ?? NUM(r.inputTokens) ?? NUM(r.input_tokens);
    const output = NUM(r.completionTokens) ?? NUM(r.completion_tokens) ?? NUM(r.outputTokens) ?? NUM(r.output_tokens);
    if (input === null || output === null)
        return null;
    const model = typeof r.model === "string" ? r.model : null;
    return {
        model,
        promptTokens: input,
        completionTokens: output,
        costUsd: NUM(r.estimated_cost_usd) ?? NUM(r.costUsd) ?? null,
        durationMs: NUM(r.duration_ms) ?? NUM(r.durationMs) ?? null,
    };
}
/**
 * Parse a usage file. Accepts a JSON array, a single JSON object, or JSONL —
 * because collecting these means a shell loop over `curl`, and which of those
 * three you end up with depends on whether you remembered `jq -s`.
 */
export function parseUsage(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return { records: [], malformed: 0 };
    const records = [];
    let malformed = 0;
    const take = (v) => {
        const r = readRecord(v);
        if (r)
            records.push(r);
        else
            malformed++;
    };
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed))
            parsed.forEach(take);
        // A wrapped list, which is what `/v1/metrics/summary`-shaped payloads look like.
        else if (parsed && typeof parsed === "object" && Array.isArray(parsed.usage))
            parsed.usage.forEach(take);
        else
            take(parsed);
        return { records, malformed };
    }
    catch {
        // Not a single JSON document — try JSONL.
    }
    for (const line of trimmed.split("\n")) {
        const l = line.trim();
        if (!l)
            continue;
        try {
            take(JSON.parse(l));
        }
        catch {
            malformed++;
        }
    }
    return { records, malformed };
}
/** Nearest-rank percentile on a sorted array. */
function pct(sorted, p) {
    if (!sorted.length)
        return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i];
}
function summarise(values) {
    const s = [...values].sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
    return { p10: pct(s, 10), median: pct(s, 50), p90: pct(s, 90), mean: Math.round(mean) };
}
/**
 * Why the median and not the mean: token distributions are right-skewed. One run
 * that hit a 400k-token context drags a mean far above anything typical, and
 * preflight already expresses uncertainty as a *range* — so the central number
 * should be the typical case and the spread is reported separately.
 */
export const MIN_SAMPLES = 5;
/**
 * `worker` is the default target because an Otter job is one unit of work: a
 * prompt in, a result out, which is precisely the `worker` shape. It is stated
 * here rather than inferred, since nothing in the data could distinguish a
 * worker from a verifier.
 */
export const DEFAULT_KIND = "worker";
export function calibrate(records, opts = {}) {
    const kind = opts.kind ?? DEFAULT_KIND;
    const minSamples = opts.minSamples ?? MIN_SAMPLES;
    const usable = records.filter((r) => r.promptTokens > 0 || r.completionTokens > 0);
    const zero = records.length - usable.length;
    const byModelMap = new Map();
    for (const r of usable)
        byModelMap.set(r.model ?? "(unreported)", (byModelMap.get(r.model ?? "(unreported)") ?? 0) + 1);
    const stats = {
        n: usable.length,
        skipped: { zero, malformed: opts.malformed ?? 0 },
        input: summarise(usable.map((r) => r.promptTokens)),
        output: summarise(usable.map((r) => r.completionTokens)),
        byModel: [...byModelMap.entries()]
            .map(([model, n]) => ({ model, n }))
            .sort((a, b) => b.n - a.n),
    };
    const before = opts.current?.profiles?.[kind] ?? DEFAULT_ASSUMPTIONS.profiles[kind];
    const after = {
        input: stats.input.median,
        output: stats.output.median,
        // Not measurable from this data. Carried through, never invented.
        cacheHitRate: before.cacheHitRate,
    };
    const refusal = usable.length < minSamples
        ? `${usable.length} usable record(s); ${minSamples} is the minimum. A profile ` +
            `derived from this few runs carries the authority of a measurement and the ` +
            `accuracy of a guess, which is worse than the documented default.`
        : undefined;
    return { kind, stats, before, after, refusal };
}
/**
 * Merge the calibrated profile into an existing config rather than replacing it.
 *
 * A `preflight.json` in a real repo also carries pricing overrides, fan-out
 * assumptions and an `asOf`. Overwriting the file would silently discard them,
 * so only the one profile being calibrated is touched.
 */
export function mergeConfig(existing, cal, meta) {
    const profiles = { ...(existing.profiles ?? {}) };
    profiles[cal.kind] = cal.after;
    const prior = existing.$calibration ?? {};
    return {
        ...existing,
        profiles,
        // Provenance, so the next reader can tell a measured number from a guess and
        // knows when it was measured. A calibrated config with no date is a config
        // that will be trusted long after it stopped being true.
        $calibration: {
            ...prior,
            [cal.kind]: {
                samples: cal.stats.n,
                source: meta.source,
                calibratedOn: meta.date,
                inputTokens: { p10: cal.stats.input.p10, median: cal.stats.input.median, p90: cal.stats.input.p90 },
                outputTokens: { p10: cal.stats.output.p10, median: cal.stats.output.median, p90: cal.stats.output.p90 },
                cacheHitRate: "not measured — carried over from the previous value",
                models: cal.stats.byModel,
            },
        },
    };
}
//# sourceMappingURL=calibrate.js.map