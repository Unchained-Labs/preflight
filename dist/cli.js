#!/usr/bin/env node
/** preflight CLI: estimate, diff, models, calibrate. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { calibrate, DEFAULT_KIND, mergeConfig, parseUsage } from "./calibrate.js";
import { diffEstimates, estimate } from "./estimate.js";
import { knownModels, PRICING, PRICING_VERIFIED, toOtterEnv } from "./pricing.js";
import { markdown, terminal } from "./report.js";
import { read } from "./spec.js";
const VERSION = "0.1.0";
const HELP = `preflight ${VERSION} — price an agent workflow before it runs

USAGE
  preflight estimate <spec>              agents, cost and the biggest levers
  preflight diff <spec> --base <ref>     before/after against a git ref
  preflight models                       the pricing table and when it was verified\n  preflight models --format otter-env    emit OTTER_MODEL_PRICING for the Kymatics stack
  preflight calibrate <usage.json>       replace a guessed token profile with a measured one

  A spec path of - reads one graph from stdin:
    localflow graph <session> | preflight estimate -

OPTIONS
  --format text|json|markdown   output format (default: text)
  --max-usd N                   exit 1 if the expected cost exceeds N
  --as-of YYYY-MM-DD            price as of this date (intro rates expire)
  --config <file>               assumption overrides (default: preflight.json)
  --kind scope|worker|verifier|synthesis   which profile calibrate writes (default: worker)
  --out <file>                  where calibrate writes (default: stdout; use - for stdout)
  --min-samples N               refuse to calibrate below this many records (default: 5)
  --no-color
  --version, --help

INPUT
  A declarative graph spec (*.graph.json) gives a tight estimate — width, tier
  and lens count are data. A script gives a wide range, because those are runtime
  values. The output marks which numbers were assumed.

CALIBRATION
  The token profiles are generic until you measure your own. Feed calibrate the
  usage rows your orchestrator already records — for Otter, that is
  GET /v1/jobs/{id}/usage — as a JSON array, a single object, or JSONL:

    for id in $(cat job-ids); do curl -s "$OTTER/v1/jobs/$id/usage"; done \\
      | jq -s . | preflight calibrate - --kind worker --out preflight.json

  It writes the median, not the mean, because token distributions are skewed. It
  does not invent a cache hit rate, because nothing in that data measures one.

EXAMPLE
  preflight estimate audit.graph.json --max-usd 20
  preflight diff audit.graph.json --base origin/main --format markdown
`;
function loadAssumptions(file) {
    const path = file ?? "preflight.json";
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch (e) {
        console.error(`preflight: cannot read ${path}: ${e.message}`);
        return {};
    }
}
function estimateFile(file, overrides) {
    const source = readFileSync(file, "utf8");
    return estimate(read(file, source), overrides);
}
/** The same file as it exists at a git ref, or null if it did not exist. */
function atRef(ref, file, overrides) {
    try {
        const source = execFileSync("git", ["show", `${ref}:${file}`], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return estimate(read(file, source), overrides);
    }
    catch {
        return null;
    }
}
const KINDS = ["scope", "worker", "verifier", "synthesis"];
/** Render the calibration as a diff against what was being assumed. */
function calibrationReport(cal, source) {
    const pct = (before, after) => before === 0 ? "—" : `${after >= before ? "×" : "×"}${(after / before).toFixed(2)}`;
    const row = (label, before, after, spread) => `  ${label.padEnd(9)} ${String(before).padStart(8)} → ${String(after).padStart(8)}  ` +
        `${pct(before, after).padStart(7)}   ${spread}`;
    const out = [
        "",
        `  calibrating the ${cal.kind} profile from ${cal.stats.n} measured call(s)`,
        "",
        `  ${"".padEnd(9)} ${"assumed".padStart(8)}   ${"measured".padStart(8)}  ${"change".padStart(7)}   p10–p90`,
        row("input", cal.before.input, cal.after.input, `${cal.stats.input.p10}–${cal.stats.input.p90}`),
        row("output", cal.before.output, cal.after.output, `${cal.stats.output.p10}–${cal.stats.output.p90}`),
        "",
    ];
    if (cal.stats.input.mean > cal.stats.input.median * 1.5) {
        out.push(`  ! the input mean (${cal.stats.input.mean}) is well above the median — a few long runs are`, "    pulling it up. The median is what got written; the p90 is the tail to budget for.", "");
    }
    out.push(`  cacheHitRate  ${cal.before.cacheHitRate} (unchanged)`, "                not measurable from usage rows — nothing in them reports cache reads", "");
    if (cal.stats.byModel.length > 1) {
        out.push("  models in the sample");
        for (const m of cal.stats.byModel)
            out.push(`    ${String(m.n).padStart(5)}  ${m.model}`);
        out.push("");
    }
    const { zero, malformed } = cal.stats.skipped;
    if (zero || malformed) {
        out.push(`  skipped  ${zero} record(s) with no tokens, ${malformed} unreadable`, "");
    }
    out.push(`  source  ${source}`, "");
    return out.join("\n");
}
function runCalibrate(o) {
    if (!KINDS.includes(o.kind)) {
        console.error(`preflight: --kind must be one of ${KINDS.join(", ")}`);
        return 2;
    }
    if (!o.file) {
        console.error("usage: preflight calibrate <usage.json|->   (- reads stdin)");
        return 2;
    }
    let text;
    const source = o.file === "-" ? "stdin" : o.file;
    try {
        text = o.file === "-" ? readFileSync(0, "utf8") : readFileSync(o.file, "utf8");
    }
    catch (e) {
        console.error(`preflight: cannot read ${source}: ${e.message}`);
        return 2;
    }
    const { records, malformed } = parseUsage(text);
    if (!records.length) {
        console.error(`preflight: no usage records in ${source}. Expected objects with prompt_tokens and ` +
            "completion_tokens — Otter's GET /v1/jobs/{id}/usage shape — as an array, a single " +
            "object, or JSONL.");
        return 2;
    }
    const cal = calibrate(records, {
        kind: o.kind,
        malformed,
        minSamples: o.minSamples,
        current: o.current,
    });
    if (o.format === "json") {
        process.stdout.write(`${JSON.stringify(cal, null, 2)}\n`);
        return cal.refusal ? 1 : 0;
    }
    process.stderr.write(calibrationReport(cal, source));
    if (cal.refusal) {
        // Exit non-zero and write nothing. Half-calibrating is the failure mode:
        // the config would carry a `$calibration` block asserting a measurement that
        // the sample does not support.
        console.error(`  refusing to write: ${cal.refusal}\n`);
        return 1;
    }
    const existing = o.out && o.out !== "-" && existsSync(o.out)
        ? JSON.parse(readFileSync(o.out, "utf8"))
        : o.current;
    // The run date is the calibration date; it is provenance, not a computed value.
    const merged = mergeConfig(existing, cal, {
        source,
        date: new Date().toISOString().slice(0, 10),
    });
    const json = `${JSON.stringify(merged, null, 2)}\n`;
    if (!o.out || o.out === "-") {
        process.stdout.write(json);
        return 0;
    }
    writeFileSync(o.out, json);
    console.error(`  wrote ${o.out}\n`);
    return 0;
}
function main() {
    const argv = process.argv.slice(2);
    if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
        console.log(HELP);
        return argv.length ? 0 : 2;
    }
    if (argv.includes("--version")) {
        console.log(VERSION);
        return 0;
    }
    if (argv.includes("--no-color"))
        process.env.NO_COLOR = "1";
    const flag = (n) => {
        const i = argv.indexOf(n);
        return i === -1 ? undefined : argv[i + 1];
    };
    const cmd = argv[0];
    // A bare `-` means stdin, so it is a positional and not a flag. And a flag's
    // value must not also count as one: `calibrate - --kind verifier` has exactly
    // one positional, and reading `verifier` as a filename is how you get
    // "cannot read verifier".
    const VALUE_FLAGS = new Set([
        "--format", "--max-usd", "--as-of", "--config", "--base", "--kind", "--out", "--min-samples",
    ]);
    const rest = argv.slice(1);
    const positional = rest.filter((a, i) => (a === "-" || !a.startsWith("-")) && !(i > 0 && VALUE_FLAGS.has(rest[i - 1])));
    const format = flag("--format") ?? "text";
    const overrides = loadAssumptions(flag("--config"));
    const asOf = flag("--as-of");
    if (asOf)
        overrides.asOf = asOf;
    if (cmd === "calibrate") {
        return runCalibrate({
            file: positional[0],
            kind: (flag("--kind") ?? DEFAULT_KIND),
            out: flag("--out"),
            minSamples: flag("--min-samples") ? Number(flag("--min-samples")) : undefined,
            format,
            configPath: flag("--config") ?? "preflight.json",
            current: overrides,
        });
    }
    if (cmd === "models") {
        // Machine-readable export for Otter's OTTER_MODEL_PRICING, so the two
        // systems share one price list rather than drifting apart.
        if (format === "otter-env") {
            console.log(toOtterEnv(asOf));
            return 0;
        }
        console.log(`\n  pricing verified ${PRICING_VERIFIED}  (USD per million tokens)\n`);
        const w = Math.max(...knownModels().map((m) => m.length));
        console.log(`  ${"model".padEnd(w)}   input   output  tier      context`);
        for (const [id, p] of Object.entries(PRICING)) {
            const intro = p.introUntil ? `  intro until ${p.introUntil} (then $${p.standardInput}/$${p.standardOutput})` : "";
            console.log(`  ${id.padEnd(w)}  ${`$${p.input}`.padStart(6)}  ${`$${p.output}`.padStart(7)}  ${p.tier.padEnd(9)} ${(p.context / 1e6 >= 1 ? `${p.context / 1e6}M` : `${p.context / 1e3}K`).padStart(5)}${intro}`);
        }
        console.log("");
        return 0;
    }
    const file = positional[0];
    if (!file) {
        console.error(`usage: preflight ${cmd} <spec>`);
        return 2;
    }
    // `-` reads one spec from stdin. Graphs are increasingly generated rather than
    // written — localflow reconstructs the one a session actually ran — and making
    // the caller land it in a temp file first is friction for no reason.
    const fromStdin = file === "-";
    if (!fromStdin && !existsSync(file)) {
        console.error(`preflight: no such file: ${file}`);
        return 2;
    }
    let after;
    try {
        after = fromStdin
            ? estimate(read("<stdin>.graph.json", readFileSync(0, "utf8")), overrides)
            : estimateFile(file, overrides);
    }
    catch (e) {
        console.error(`preflight: ${e.message}`);
        return 2;
    }
    const base = flag("--base");
    const before = cmd === "diff" && base ? atRef(base, file, overrides) : null;
    const d = diffEstimates(before, after);
    if (format === "json")
        process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
    else if (format === "markdown")
        process.stdout.write(`${markdown(d, { file })}\n`);
    else
        process.stdout.write(terminal(after));
    const cap = flag("--max-usd");
    if (cap !== undefined && after.usd.expected > Number(cap)) {
        console.error(`preflight: expected cost $${after.usd.expected.toFixed(2)} exceeds --max-usd ${cap}`);
        return 1;
    }
    return 0;
}
process.exitCode = main();
//# sourceMappingURL=cli.js.map