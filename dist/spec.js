/**
 * Reads a workflow into the minimal shape the cost model needs: how many calls,
 * at what tier, with how many verifier lenses, inside how many rounds.
 *
 * Two inputs, with honestly different accuracy:
 *
 * - **A declarative spec** states fan-out width, tier and lens count as data.
 *   The estimate is then arithmetic on numbers you wrote down, and it is tight.
 * - **A script** hides those numbers behind runtime values. We recover what is
 *   statically visible and mark the rest as assumed. The estimate is a range and
 *   the range is wide. This is a property of the input, not a limitation we can
 *   engineer away, so the output says which nodes were assumed.
 *
 * If you want a tight number, write the spec.
 */
import { parse } from "acorn";
// --- declarative -------------------------------------------------------------
export function readSpec(source) {
    const raw = JSON.parse(source);
    const warnings = [];
    const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const edges = Array.isArray(raw.edges) ? raw.edges : [];
    const hasOutbound = new Set(edges.map((e) => e.from));
    const nodes = rawNodes
        .filter((n) => typeof n?.id === "string")
        .map((n) => {
        const lenses = Array.isArray(n.harness?.lenses)
            ? n.harness.lenses.filter((l) => typeof l === "string")
            : [];
        const width = typeof n.fanout?.width === "number"
            ? n.fanout.width
            : typeof n.fanout?.maxConcurrent === "number"
                ? n.fanout.maxConcurrent
                : n.fanout
                    ? -1
                    : null;
        if (width === -1) {
            warnings.push(`node "${n.id}" fans out but states no width — using the assumed range. Add \`fanout.width\` for a tighter estimate.`);
        }
        return {
            id: n.id,
            tier: typeof n.tier === "string" ? n.tier : null,
            model: typeof n.model === "string" ? n.model : null,
            fanout: width,
            lenses,
            isVerifier: Boolean(n.harness) || /verif|judge|skeptic|lens/i.test(n.id),
            inCycle: false,
            terminal: !hasOutbound.has(n.id),
        };
    });
    // Cycle detection: any back edge into an already-seen node.
    const order = new Map(nodes.map((n, i) => [n.id, i]));
    const backEdges = edges.filter((e) => {
        const from = order.get(e.from);
        const to = order.get(e.to);
        return from !== undefined && to !== undefined && to <= from;
    });
    const hasCycle = backEdges.length > 0;
    if (hasCycle) {
        const inCycle = new Set(backEdges.flatMap((e) => [e.from, e.to]));
        for (const n of nodes)
            if (inCycle.has(n.id))
                n.inCycle = true;
    }
    let cycleRounds = null;
    const capped = rawNodes.find((n) => typeof n?.loop?.maxRounds === "number");
    if (capped) {
        const max = capped.loop.maxRounds;
        cycleRounds = { low: 1, expected: Math.max(1, Math.ceil(max / 2)), high: max };
    }
    return {
        name: typeof raw.name === "string" ? raw.name : null,
        kind: "spec",
        nodes,
        hasCycle,
        cycleRounds,
        budget: raw.budget
            ? {
                usd: typeof raw.budget.usd === "number" ? raw.budget.usd : null,
                tokens: typeof raw.budget.tokens === "number" ? raw.budget.tokens : null,
            }
            : null,
        warnings,
    };
}
// --- scripts -----------------------------------------------------------------
const VERIFIER_WORDS = /verify|refute|skeptic|judge|adjudicate|is this real|critique/i;
/**
 * Recover call sites from a script. Deliberately shallow: we count `agent()`
 * calls, read `model`, spot `Array.from({length:N})` and literal arrays for
 * width, and detect `while` loops. Anything driven by a runtime value is marked
 * assumed rather than guessed at.
 */
export function readScript(source) {
    const warnings = [];
    const nodes = [];
    let hasCycle = false;
    let cycleRounds = null;
    let name = null;
    let budget = null;
    let seq = 0;
    let ast;
    try {
        ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
    }
    catch (e) {
        throw new Error(`cannot parse script: ${e.message}`);
    }
    const text = (n) => {
        if (!n)
            return null;
        if (n.type === "Literal" && typeof n.value === "string")
            return n.value;
        if (n.type === "TemplateLiteral")
            return n.quasis.map((q) => q.value.cooked ?? "").join(" ");
        return null;
    };
    const props = (n) => {
        const m = new Map();
        if (n?.type !== "ObjectExpression")
            return m;
        for (const p of n.properties) {
            if (p.type === "Property" && !p.computed) {
                const k = p.key.type === "Identifier" ? p.key.name : p.key.value;
                if (typeof k === "string")
                    m.set(k, p.value);
            }
        }
        return m;
    };
    const callee = (n) => {
        if (!n)
            return "";
        if (n.type === "Identifier")
            return n.name;
        if (n.type === "MemberExpression")
            return `${callee(n.object)}.${n.property?.name ?? ""}`;
        return "";
    };
    // meta
    const metaMatch = /export\s+const\s+meta\s*=/.exec(source);
    if (metaMatch) {
        const nameM = /name\s*:\s*['"`]([^'"`]+)/.exec(source.slice(metaMatch.index, metaMatch.index + 600));
        if (nameM)
            name = nameM[1];
        const usdM = /budget\s*:\s*\{[^}]*usd\s*:\s*([\d_]+)/.exec(source);
        const tokM = /budget\s*:\s*\{[^}]*tokens\s*:\s*([\d_]+)/.exec(source);
        if (usdM || tokM) {
            budget = {
                usd: usdM ? Number(usdM[1].replace(/_/g, "")) : null,
                tokens: tokM ? Number(tokM[1].replace(/_/g, "")) : null,
            };
        }
    }
    const walk = (n, ctx) => {
        if (!n || typeof n !== "object")
            return;
        if (n.type === "CallExpression") {
            const name = callee(n.callee);
            if (name === "agent") {
                const o = props(n.arguments[1]);
                const prompt = text(n.arguments[0]) ?? "";
                const label = text(o.get("label"));
                const id = label ?? `agent#${++seq}`;
                nodes.push({
                    id,
                    tier: null,
                    model: text(o.get("model")),
                    fanout: ctx.width,
                    lenses: [],
                    isVerifier: VERIFIER_WORDS.test(prompt) || VERIFIER_WORDS.test(label ?? ""),
                    inCycle: ctx.inCycle,
                    terminal: false,
                });
                if (ctx.width === null) {
                    warnings.push(`"${id}": width not statically known — using the assumed range`);
                }
            }
            // width from a literal array or an Array.from length
            if (name === "parallel" || name === "pipeline") {
                const arg = n.arguments[0];
                let width = null;
                if (arg?.type === "ArrayExpression")
                    width = arg.elements.length;
                const src = source.slice(n.start, n.end);
                const af = /Array\.from\(\s*\{\s*length\s*:\s*(\d+)/.exec(src);
                if (af)
                    width = Number(af[1]);
                const inner = { ...ctx, width: width ?? -1 };
                for (const k of keys(n))
                    walkAny(n[k], inner);
                return;
            }
        }
        if (n.type === "WhileStatement" || n.type === "DoWhileStatement") {
            hasCycle = true;
            const body = source.slice(n.start, n.end);
            const capM = /(?:rounds?|iter\w*|attempts?)\s*<=?\s*(\d+)|max(?:Rounds|Iterations)\s*=\s*(\d+)/i.exec(body);
            if (capM) {
                const max = Number(capM[1] ?? capM[2]);
                cycleRounds = { low: 1, expected: Math.max(1, Math.ceil(max / 2)), high: max };
            }
            for (const k of keys(n))
                walkAny(n[k], { ...ctx, inCycle: true });
            return;
        }
        for (const k of keys(n))
            walkAny(n[k], ctx);
    };
    const walkAny = (v, ctx) => {
        if (Array.isArray(v))
            for (const c of v)
                walk(c, ctx);
        else
            walk(v, ctx);
    };
    walk(ast, { inCycle: false, width: null });
    // The last node with no downstream agent is the synthesis step.
    if (nodes.length)
        nodes[nodes.length - 1].terminal = true;
    // A verifier in a script has one lens unless the surrounding code maps lenses.
    const lensArray = /(?:LENSES|lenses)\s*=\s*\[([^\]]*)\]/.exec(source);
    if (lensArray) {
        const count = lensArray[1].split(",").filter((s) => s.trim()).length;
        for (const node of nodes)
            if (node.isVerifier)
                node.lenses = Array.from({ length: count }, (_, i) => `lens${i}`);
    }
    if (hasCycle && !cycleRounds) {
        warnings.push("a cycle with no statically visible round cap — using the assumed range");
    }
    warnings.push("this is a script, so fan-out widths and finding counts are mostly runtime values. Estimates from a declarative spec are far tighter.");
    return { name, kind: "script", nodes, hasCycle, cycleRounds, budget, warnings };
}
function keys(n) {
    return Object.keys(n).filter((k) => !["type", "start", "end", "loc", "range"].includes(k));
}
export function read(file, source) {
    const isJson = file.endsWith(".json") || source.trimStart().startsWith("{");
    return isJson ? readSpec(source) : readScript(source);
}
//# sourceMappingURL=spec.js.map