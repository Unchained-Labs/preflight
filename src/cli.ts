#!/usr/bin/env node
/** preflight CLI: estimate, diff, models. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { diffEstimates, estimate } from "./estimate.js";
import type { Assumptions, Estimate } from "./estimate.js";
import { knownModels, PRICING, PRICING_VERIFIED, toOtterEnv } from "./pricing.js";
import { markdown, terminal } from "./report.js";
import { read } from "./spec.js";

const VERSION = "0.1.0";

const HELP = `preflight ${VERSION} — price an agent workflow before it runs

USAGE
  preflight estimate <spec>              agents, cost and the biggest levers
  preflight diff <spec> --base <ref>     before/after against a git ref
  preflight models                       the pricing table and when it was verified\n  preflight models --format otter-env    emit OTTER_MODEL_PRICING for the Kymatics stack

OPTIONS
  --format text|json|markdown   output format (default: text)
  --max-usd N                   exit 1 if the expected cost exceeds N
  --as-of YYYY-MM-DD            price as of this date (intro rates expire)
  --config <file>               assumption overrides (default: preflight.json)
  --no-color
  --version, --help

INPUT
  A declarative graph spec (*.graph.json) gives a tight estimate — width, tier
  and lens count are data. A script gives a wide range, because those are runtime
  values. The output marks which numbers were assumed.

EXAMPLE
  preflight estimate audit.graph.json --max-usd 20
  preflight diff audit.graph.json --base origin/main --format markdown
`;

function loadAssumptions(file: string | undefined): Partial<Assumptions> {
  const path = file ?? "preflight.json";
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<Assumptions>;
  } catch (e) {
    console.error(`preflight: cannot read ${path}: ${(e as Error).message}`);
    return {};
  }
}

function estimateFile(file: string, overrides: Partial<Assumptions>): Estimate {
  const source = readFileSync(file, "utf8");
  return estimate(read(file, source), overrides);
}

/** The same file as it exists at a git ref, or null if it did not exist. */
function atRef(ref: string, file: string, overrides: Partial<Assumptions>): Estimate | null {
  try {
    const source = execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return estimate(read(file, source), overrides);
  } catch {
    return null;
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return argv.length ? 0 : 2;
  }
  if (argv.includes("--version")) {
    console.log(VERSION);
    return 0;
  }
  if (argv.includes("--no-color")) process.env.NO_COLOR = "1";

  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const cmd = argv[0];
  const positional = argv.slice(1).filter((a) => !a.startsWith("-"));
  const format = flag("--format") ?? "text";
  const overrides = loadAssumptions(flag("--config"));
  const asOf = flag("--as-of");
  if (asOf) overrides.asOf = asOf;

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
      console.log(
        `  ${id.padEnd(w)}  ${`$${p.input}`.padStart(6)}  ${`$${p.output}`.padStart(7)}  ${p.tier.padEnd(9)} ${(p.context / 1e6 >= 1 ? `${p.context / 1e6}M` : `${p.context / 1e3}K`).padStart(5)}${intro}`,
      );
    }
    console.log("");
    return 0;
  }

  const file = positional[0];
  if (!file) {
    console.error(`usage: preflight ${cmd} <spec>`);
    return 2;
  }
  if (!existsSync(file)) {
    console.error(`preflight: no such file: ${file}`);
    return 2;
  }

  let after: Estimate;
  try {
    after = estimateFile(file, overrides);
  } catch (e) {
    console.error(`preflight: ${(e as Error).message}`);
    return 2;
  }

  const base = flag("--base");
  const before = cmd === "diff" && base ? atRef(base, file, overrides) : null;
  const d = diffEstimates(before, after);

  if (format === "json") process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
  else if (format === "markdown") process.stdout.write(`${markdown(d, { file })}\n`);
  else process.stdout.write(terminal(after));

  const cap = flag("--max-usd");
  if (cap !== undefined && after.usd.expected > Number(cap)) {
    console.error(
      `preflight: expected cost $${after.usd.expected.toFixed(2)} exceeds --max-usd ${cap}`,
    );
    return 1;
  }
  return 0;
}

process.exitCode = main();
