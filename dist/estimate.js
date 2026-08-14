/**
 * The cost model.
 *
 *   cost ≈ Σ_nodes    (fanout × tier_rate)
 *        + Σ_findings  (findings × lenses × verify_rate)   ← the term that bites
 *        + retries     × schema_mismatch_rate
 *        + rounds      (if the graph has a cycle)
 *
 * Two design commitments, because a cost estimator lives or dies on whether
 * people believe it:
 *
 * 1. **Every assumption is named, printed, and overridable.** The output shows
 *    the token profile it used per node kind. A number with hidden assumptions is
 *    a number nobody can argue with, which means nobody can trust it either.
 *
 * 2. **It reports a range, not a point.** Fan-out width, finding counts and
 *    round counts are usually unknown until the run happens. Emitting "$12.40"
 *    implies a precision the input does not contain, so the estimate is
 *    low/expected/high and the drivers are ranked.
 */
import { PRICING_VERIFIED, priceOf, resolveModel } from "./pricing.js";
export const DEFAULT_PROFILES = {
    // Decomposition: a moderate prompt, a structured plan out.
    scope: { input: 4_000, output: 2_000, cacheHitRate: 0 },
    // One unit of work: the unit's content in, a schema-constrained result out.
    worker: { input: 8_000, output: 800, cacheHitRate: 0.7 },
    // One lens on one finding: the finding plus context in, a verdict out.
    verifier: { input: 3_000, output: 400, cacheHitRate: 0.8 },
    // Final judgment: everything that survived in, prose out.
    synthesis: { input: 20_000, output: 4_000, cacheHitRate: 0 },
};
export const DEFAULT_ASSUMPTIONS = {
    profiles: DEFAULT_PROFILES,
    findingsPerWorker: { low: 0.2, expected: 0.6, high: 1.5 },
    unknownFanout: { low: 5, expected: 20, high: 80 },
    unknownRounds: { low: 1, expected: 3, high: 8 },
    schemaRetryRate: 0.05,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
};
/** Classify a node so the right token profile applies. */
export function classify(node) {
    if (node.isVerifier || node.lenses.length > 0)
        return "verifier";
    const id = node.id.toLowerCase();
    if (/^(scope|plan|decompose|enumerate|index|split)/.test(id))
        return "scope";
    if (/(report|synth|write|summar|rank|adjudicat|digest)/.test(id))
        return "synthesis";
    if (node.fanout !== null && node.fanout !== 1)
        return "worker";
    // A node with no fan-out and nothing downstream is doing final judgment.
    return node.terminal ? "synthesis" : "worker";
}
function usdFor(calls, profile, price, a) {
    if (calls <= 0)
        return { usd: 0, input: 0, output: 0 };
    const cached = profile.cacheHitRate;
    // First call writes the cache; the rest read it. With no repetition there is
    // nothing to share, so a single call pays the plain rate.
    const writeCalls = cached > 0 && calls > 1 ? 1 : 0;
    const readCalls = calls - writeCalls;
    const cachedPortion = profile.input * cached;
    const freshPortion = profile.input - cachedPortion;
    const inputUsd = 
    // fresh input on every call
    (calls * freshPortion * price.input) / 1e6 +
        // the shared prefix, written once at a premium
        (writeCalls * cachedPortion * price.input * a.cacheWriteMultiplier) / 1e6 +
        // and read cheaply thereafter
        (readCalls * cachedPortion * price.input * a.cacheReadMultiplier) / 1e6;
    const outputUsd = (calls * profile.output * price.output) / 1e6;
    const retryFactor = 1 + a.schemaRetryRate;
    return {
        usd: (inputUsd + outputUsd) * retryFactor,
        input: calls * profile.input * retryFactor,
        output: calls * profile.output * retryFactor,
    };
}
export function estimate(spec, overrides = {}) {
    const a = {
        ...DEFAULT_ASSUMPTIONS,
        asOf: new Date().toISOString().slice(0, 10),
        ...overrides,
        profiles: { ...DEFAULT_PROFILES, ...(overrides.profiles ?? {}) },
    };
    const warnings = [...spec.warnings];
    const nodes = [];
    const byKind = { scope: 0, worker: 0, verifier: 0, synthesis: 0 };
    // How many workers run, at each bound — the verification term depends on it.
    const workerCalls = { low: 0, expected: 0, high: 0 };
    // Rounds multiply everything inside a cycle.
    const rounds = spec.cycleRounds ?? (spec.hasCycle ? a.unknownRounds : { low: 1, expected: 1, high: 1 });
    if (spec.hasCycle && !spec.cycleRounds) {
        warnings.push(`the graph has a cycle with no declared round cap — assuming ${rounds.low}/${rounds.expected}/${rounds.high} rounds. Declare a cap and this estimate gets much tighter.`);
    }
    // --- pass 1: everything that is not a verifier ----------------------------
    for (const node of spec.nodes) {
        const kind = classify(node);
        if (kind === "verifier")
            continue;
        const price = priceOf(node.model ?? tierModel(node.tier), a.asOf);
        const profile = a.profiles[kind];
        const widthAssumed = node.fanout === -1 || (node.fanout === null && kind === "worker");
        const width = node.fanout && node.fanout > 0
            ? { low: node.fanout, expected: node.fanout, high: node.fanout }
            : widthAssumed
                ? a.unknownFanout
                : { low: 1, expected: 1, high: 1 };
        const mult = node.inCycle ? rounds : { low: 1, expected: 1, high: 1 };
        const calls = {
            low: width.low * mult.low,
            expected: width.expected * mult.expected,
            high: width.high * mult.high,
        };
        const low = usdFor(calls.low, profile, price, a);
        const exp = usdFor(calls.expected, profile, price, a);
        const high = usdFor(calls.high, profile, price, a);
        if (kind === "worker") {
            workerCalls.low += calls.low;
            workerCalls.expected += calls.expected;
            workerCalls.high += calls.high;
        }
        byKind[kind] += exp.usd;
        nodes.push({
            id: node.id,
            kind,
            model: price.model,
            tier: price.tier,
            calls,
            usd: { low: low.usd, expected: exp.usd, high: high.usd },
            inputTokens: exp.input,
            outputTokens: exp.output,
            widthAssumed,
            ...(node.model === null ? { note: "no model set — assumed the session model" } : {}),
        });
        if (node.model === null && node.tier === null) {
            warnings.push(`node "${node.id}" sets no model or tier, so it inherits the session model. Priced as ${price.model}.`);
        }
    }
    // --- pass 2: verifiers, which scale with findings × lenses ----------------
    for (const node of spec.nodes) {
        if (classify(node) !== "verifier")
            continue;
        const lenses = Math.max(node.lenses.length, 1);
        const price = priceOf(node.model ?? tierModel(node.tier), a.asOf);
        const profile = a.profiles.verifier;
        // findings = workers × findings-per-worker. This is the growth term.
        //
        // Unless the node states its own width. A spec that *starts* at the verify
        // stage — authsweep's emitted verify graph, for instance — has no upstream
        // workers, so deriving findings from worker calls yields zero and the whole
        // stage prices at nothing. An explicit `fanout.width` is a real count and
        // beats an inference every time.
        const declared = node.fanout !== null && node.fanout > 0 ? node.fanout : null;
        const findings = declared
            ? { low: declared, expected: declared, high: declared }
            : {
                low: workerCalls.low * a.findingsPerWorker.low,
                expected: workerCalls.expected * a.findingsPerWorker.expected,
                high: workerCalls.high * a.findingsPerWorker.high,
            };
        if (declared === null && workerCalls.expected === 0) {
            warnings.push(`node "${node.id}" is a verifier but nothing upstream produces findings and it declares no \`fanout.width\` — priced at zero. Declare a width if this stage runs standalone.`);
        }
        const calls = {
            low: Math.ceil(findings.low * lenses),
            expected: Math.ceil(findings.expected * lenses),
            high: Math.ceil(findings.high * lenses),
        };
        const low = usdFor(calls.low, profile, price, a);
        const exp = usdFor(calls.expected, profile, price, a);
        const high = usdFor(calls.high, profile, price, a);
        byKind.verifier += exp.usd;
        nodes.push({
            id: node.id,
            kind: "verifier",
            model: price.model,
            tier: price.tier,
            calls,
            usd: { low: low.usd, expected: exp.usd, high: high.usd },
            inputTokens: exp.input,
            outputTokens: exp.output,
            widthAssumed: declared === null,
            note: declared
                ? `${lenses} lens${lenses === 1 ? "" : "es"} × ${declared} declared findings`
                : `${lenses} lens${lenses === 1 ? "" : "es"} × findings from ${workerCalls.expected} worker calls`,
        });
        if (node.lenses.length > 1 && new Set(node.lenses).size < node.lenses.length) {
            warnings.push(`node "${node.id}" declares duplicate lenses — you are paying for them and getting one check. See decorrelate.`);
        }
    }
    const sum = (k) => nodes.reduce((s, n) => s + n.usd[k], 0);
    const agents = {
        low: nodes.reduce((s, n) => s + n.calls.low, 0),
        expected: nodes.reduce((s, n) => s + n.calls.expected, 0),
        high: nodes.reduce((s, n) => s + n.calls.high, 0),
    };
    const usd = { low: sum("low"), expected: sum("expected"), high: sum("high") };
    // --- drivers: what to change to move the number ---------------------------
    const total = usd.expected || 1;
    const drivers = nodes
        .map((n) => ({
        what: `${n.id} (${n.kind})`,
        usd: n.usd.expected,
        share: n.usd.expected / total,
        lever: leverFor(n),
    }))
        .filter((d) => d.usd > 0)
        .sort((x, y) => y.usd - x.usd)
        .slice(0, 5);
    const budget = spec.budget
        ? {
            usd: spec.budget.usd,
            tokens: spec.budget.tokens,
            overBy: spec.budget.usd !== null ? usd.expected - spec.budget.usd : null,
        }
        : null;
    if (budget?.overBy !== null && budget?.overBy !== undefined && budget.overBy > 0) {
        warnings.push(`the expected cost of $${usd.expected.toFixed(2)} exceeds the declared budget of $${budget.usd.toFixed(2)} by $${budget.overBy.toFixed(2)}.`);
    }
    return {
        name: spec.name,
        agents,
        usd,
        tokens: {
            input: nodes.reduce((s, n) => s + n.inputTokens, 0),
            output: nodes.reduce((s, n) => s + n.outputTokens, 0),
        },
        nodes: nodes.sort((x, y) => y.usd.expected - x.usd.expected),
        byKind,
        drivers,
        budget,
        warnings,
        assumptions: a,
        pricingVerified: PRICING_VERIFIED,
    };
}
function tierModel(tier) {
    if (!tier)
        return null;
    const map = {
        cheap: "claude-haiku-4-5",
        standard: "claude-sonnet-5",
        deep: "claude-opus-5",
    };
    return map[tier] ?? null;
}
function leverFor(n) {
    if (n.kind === "verifier")
        return "drop a lens, or replace one with an executable oracle";
    if (n.kind === "worker" && n.tier === "deep")
        return "this fan-out is on the deep tier — demote it";
    if (n.kind === "worker")
        return "narrow the fan-out, or add a zero-token prefilter";
    if (n.kind === "synthesis")
        return "usually correct to keep deep — judgment reaching the user";
    return "scope quality sets the ceiling downstream; usually worth the deep tier";
}
export function diffEstimates(before, after) {
    if (!before) {
        return { before: null, after, usdDelta: null, agentDelta: null, changes: [] };
    }
    const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
    const afterById = new Map(after.nodes.map((n) => [n.id, n]));
    const changes = [];
    for (const [id, n] of afterById) {
        const b = beforeById.get(id);
        if (!b)
            changes.push({ id, kind: "added", to: n.usd.expected });
        else if (Math.abs(b.usd.expected - n.usd.expected) > 0.005) {
            changes.push({ id, kind: "changed", from: b.usd.expected, to: n.usd.expected });
        }
    }
    for (const [id, n] of beforeById) {
        if (!afterById.has(id))
            changes.push({ id, kind: "removed", from: n.usd.expected });
    }
    return {
        before,
        after,
        usdDelta: after.usd.expected - before.usd.expected,
        agentDelta: after.agents.expected - before.agents.expected,
        changes: changes.sort((x, y) => (y.to ?? y.from ?? 0) - (x.to ?? x.from ?? 0)),
    };
}
//# sourceMappingURL=estimate.js.map