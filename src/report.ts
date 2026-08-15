/** Renderers: a terminal report, and the markdown that goes on the PR. */
import { cacheWriteMultiplierFor } from "./estimate.js";
import type { Estimate, EstimateDiff } from "./estimate.js";

const colour = process.env.NO_COLOR === undefined && Boolean(process.stdout.isTTY);
const c = (code: string) => (s: string) => (colour ? `[${code}m${s}[0m` : s);
const bold = c("1");
const dim = c("2");
const grey = c("90");
const green = c("32");
const yellow = c("33");
const red = c("31");
const cyan = c("36");

const money = (n: number) => (n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));

const KIND_LABEL: Record<string, string> = {
  scope: "scope",
  worker: "fan-out",
  verifier: "verify",
  synthesis: "synthesis",
};

export function terminal(e: Estimate): string {
  const out: string[] = [];
  out.push("");
  out.push(`  ${bold(e.name ?? "workflow")}  ${grey("estimated before running")}`);
  out.push("");
  out.push(
    `  ${dim("agents")}     ${String(e.agents.expected).padStart(5)}  ${grey(`(${e.agents.low}–${e.agents.high})`)}`,
  );
  out.push(
    `  ${dim("cost")}       ${bold(money(e.usd.expected)).padStart(5)}  ${grey(`(${money(e.usd.low)}–${money(e.usd.high)})`)}`,
  );
  out.push(
    `  ${dim("tokens")}     ${compact(e.tokens.input).padStart(5)} in  ${compact(e.tokens.output)} out`,
  );

  if (e.budget?.usd !== null && e.budget?.usd !== undefined) {
    const over = e.budget.overBy ?? 0;
    const mark = over > 0 ? red("✗ over") : green("✓ under");
    out.push(`  ${dim("budget")}     ${money(e.budget.usd)}  ${mark}`);
  }
  out.push("");

  // Where the money goes.
  const total = e.usd.expected || 1;
  out.push(bold("  where it goes"));
  out.push("");
  for (const [kind, usd] of Object.entries(e.byKind).sort((a, b) => b[1] - a[1])) {
    if (usd <= 0) continue;
    const share = usd / total;
    const width = Math.max(1, Math.round(share * 28));
    const paint = kind === "verifier" ? yellow : cyan;
    out.push(
      `  ${KIND_LABEL[kind]!.padEnd(10)} ${paint("█".repeat(width))}${grey("░".repeat(28 - width))} ${money(usd).padStart(8)}  ${grey(`${Math.round(share * 100)}%`)}`,
    );
  }
  out.push("");

  if (e.byKind.verifier / total > 0.4) {
    out.push(
      `  ${yellow("!")} verification is ${Math.round((e.byKind.verifier / total) * 100)}% of this run. ` +
        `${grey("findings × lenses, not fan-out width, is usually the growth term.")}`,
    );
    out.push("");
  }

  out.push(bold("  nodes"));
  out.push("");
  const w = Math.max(...e.nodes.map((n) => n.id.length), 4);
  out.push(
    `  ${grey("node".padEnd(w))}  ${grey("kind".padEnd(9))} ${grey("model".padEnd(18))} ${grey("calls".padStart(6))} ${grey("cost".padStart(9))}`,
  );
  for (const n of e.nodes) {
    const assumed = n.widthAssumed ? yellow("~") : " ";
    out.push(
      `  ${n.id.padEnd(w)}  ${KIND_LABEL[n.kind]!.padEnd(9)} ${n.model.padEnd(18)} ${assumed}${String(n.calls.expected).padStart(5)} ${money(n.usd.expected).padStart(9)}`,
    );
  }
  out.push(`  ${grey("~ = width or count assumed, not read from the spec")}`);
  out.push("");

  if (e.drivers.length) {
    out.push(bold("  biggest levers"));
    out.push("");
    for (const d of e.drivers.slice(0, 3)) {
      out.push(`  ${money(d.usd).padStart(9)}  ${d.what}`);
      out.push(`  ${" ".repeat(9)}  ${grey(d.lever)}`);
    }
    out.push("");
  }

  if (e.warnings.length) {
    for (const wn of e.warnings) out.push(`  ${yellow("!")} ${dim(wn)}`);
    out.push("");
  }

  out.push(
    grey(
      `  assumptions: ${e.assumptions.profiles.worker.input / 1000}k in / ${e.assumptions.profiles.worker.output} out per fan-out call, ` +
        `${e.assumptions.findingsPerWorker.expected} findings per unit, ${Math.round(e.assumptions.schemaRetryRate * 100)}% schema retries.`,
    ),
  );
  out.push(grey(`  prices verified ${e.pricingVerified}; override in preflight.json.`));
  out.push("");
  return out.join("\n");
}

// --- the PR comment ----------------------------------------------------------

const MARKER = "<!-- preflight-cost -->";

export function markerFor(): string {
  return MARKER;
}

/**
 * The PR comment. Kept short by default and puts detail behind a `<details>`,
 * because a bot that writes a wall of text on every push gets muted.
 */
export function markdown(d: EstimateDiff, opts: { file: string; sha?: string } = { file: "" }): string {
  const e = d.after;
  const total = e.usd.expected || 1;
  const lines: string[] = [MARKER];

  const arrow =
    d.usdDelta === null
      ? ""
      : d.usdDelta > 0.005
        ? `📈 **+${money(d.usdDelta)}**`
        : d.usdDelta < -0.005
          ? `📉 **${money(d.usdDelta)}**`
          : "→ no change";

  lines.push(`### Predicted cost — \`${e.name ?? opts.file}\``);
  lines.push("");
  lines.push(
    `| | agents | cost | tokens |\n|:--|--:|--:|--:|\n` +
      `| **expected** | ${e.agents.expected} | **${money(e.usd.expected)}** | ${compact(e.tokens.input)} in · ${compact(e.tokens.output)} out |\n` +
      `| range | ${e.agents.low}–${e.agents.high} | ${money(e.usd.low)}–${money(e.usd.high)} | |`,
  );
  lines.push("");

  if (arrow) {
    lines.push(
      `${arrow} against the base branch${
        d.agentDelta ? ` (${d.agentDelta > 0 ? "+" : ""}${d.agentDelta} agents)` : ""
      }`,
    );
    lines.push("");
  }

  if (e.budget?.usd !== null && e.budget?.usd !== undefined) {
    const over = e.budget.overBy ?? 0;
    lines.push(
      over > 0
        ? `> [!WARNING]\n> Expected cost **exceeds the declared budget** of ${money(e.budget.usd)} by ${money(over)}.`
        : `✅ Within the declared budget of ${money(e.budget.usd)}.`,
    );
    lines.push("");
  }

  // Where it goes — a compact bar in text.
  const kinds = Object.entries(e.byKind).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (kinds.length) {
    lines.push("| stage | cost | share |");
    lines.push("|:--|--:|:--|");
    for (const [kind, usd] of kinds) {
      const pct = Math.round((usd / total) * 100);
      lines.push(`| ${KIND_LABEL[kind]} | ${money(usd)} | ${"▇".repeat(Math.max(1, Math.round(pct / 5)))} ${pct}% |`);
    }
    lines.push("");
  }

  if (e.byKind.verifier / total > 0.4) {
    lines.push(
      `> [!NOTE]\n> Verification is ${Math.round((e.byKind.verifier / total) * 100)}% of this run. Findings × lenses is usually the growth term, not fan-out width — dropping one lens is the cheapest lever here.`,
    );
    lines.push("");
  }

  if (d.changes.length) {
    lines.push("<details><summary>What changed in this PR</summary>");
    lines.push("");
    lines.push("| node | change |");
    lines.push("|:--|:--|");
    for (const ch of d.changes.slice(0, 15)) {
      const desc =
        ch.kind === "added"
          ? `added, ${money(ch.to!)}`
          : ch.kind === "removed"
            ? `removed, was ${money(ch.from!)}`
            : `${money(ch.from!)} → ${money(ch.to!)}`;
      lines.push(`| \`${ch.id}\` | ${desc} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  lines.push("<details><summary>Nodes and assumptions</summary>");
  lines.push("");
  lines.push("| node | stage | model | calls | cost |");
  lines.push("|:--|:--|:--|--:|--:|");
  for (const n of e.nodes) {
    lines.push(
      `| \`${n.id}\` | ${KIND_LABEL[n.kind]} | \`${n.model}\` | ${n.widthAssumed ? "~" : ""}${n.calls.expected} | ${money(n.usd.expected)} |`,
    );
  }
  lines.push("");
  lines.push("`~` = width or count assumed rather than read from the spec.");
  lines.push("");
  lines.push(
    `**Assumptions:** ${e.assumptions.profiles.worker.input / 1000}k in / ${e.assumptions.profiles.worker.output} out per fan-out call, ` +
      `${e.assumptions.profiles.verifier.input / 1000}k in / ${e.assumptions.profiles.verifier.output} out per verifier lens, ` +
      `${e.assumptions.findingsPerWorker.expected} findings per unit, ${Math.round(e.assumptions.schemaRetryRate * 100)}% schema retries, ` +
      `prompt cache reads at ${e.assumptions.cacheReadMultiplier}×, ` +
      `${e.assumptions.cacheTtl} cache writes at ${cacheWriteMultiplierFor(e.assumptions)}×. ` +
      "Override in \`preflight.json\`.",
  );
  lines.push("");
  if (e.warnings.length) {
    lines.push("**Warnings**");
    lines.push("");
    for (const w of e.warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("</details>");
  lines.push("");
  lines.push(
    `<sub>Estimated by [preflight](https://unchained-labs.github.io/preflight/) · prices verified ${e.pricingVerified} · this is an estimate, not a quote</sub>`,
  );

  return lines.join("\n");
}

export { money };
