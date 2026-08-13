#!/usr/bin/env node
/**
 * The GitHub Action entrypoint.
 *
 * Deliberately dependency-free — no @actions/core, no @actions/github. This runs
 * as a composite action on whatever runner is available, and a cost bot that
 * needs a 40MB install to post one comment is a cost bot nobody adopts. The two
 * things it needs from the toolkit (outputs and a PR comment) are five lines of
 * file append and one fetch.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { diffEstimates, estimate } from "./estimate.js";
import type { Assumptions, Estimate } from "./estimate.js";
import { markdown, markerFor } from "./report.js";
import { read } from "./spec.js";

const env = (k: string, d = "") => process.env[k]?.trim() || d;

function setOutput(name: string, value: string): void {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

function log(level: "notice" | "warning" | "error", msg: string): void {
  console.log(`::${level}::${msg.replace(/\n/g, "%0A")}`);
}

/** Expand the configured globs with git, which is already present on runners. */
function findSpecs(patterns: string[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    try {
      const files = execFileSync("git", ["ls-files", p], { encoding: "utf8" })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const f of files) out.add(f);
    } catch {
      /* pattern matched nothing */
    }
  }
  return [...out].filter((f) => /\.(json|js|mjs|ts)$/.test(f) && existsSync(f));
}

function atBase(base: string, file: string, o: Partial<Assumptions>): Estimate | null {
  if (!base) return null;
  try {
    const src = execFileSync("git", ["show", `${base}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return estimate(read(file, src), o);
  } catch {
    return null; // new file in this PR
  }
}

async function upsertComment(body: string): Promise<void> {
  const token = env("GITHUB_TOKEN");
  const repo = env("GITHUB_REPOSITORY");
  const eventPath = env("GITHUB_EVENT_PATH");
  if (!token || !repo || !eventPath) {
    log("warning", "no token or event payload — skipping the PR comment");
    return;
  }

  let prNumber: number | undefined;
  try {
    const ev = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { number: number } };
    prNumber = ev.pull_request?.number;
  } catch {
    /* not a PR event */
  }
  if (!prNumber) {
    log("notice", "not a pull_request event — printing the report instead of commenting");
    console.log(body);
    return;
  }

  const api = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "preflight-cost",
  };

  // Update our own comment rather than adding one per push.
  try {
    const existing = (await (await fetch(`${api}?per_page=100`, { headers })).json()) as {
      id: number;
      body?: string;
    }[];
    const mine = Array.isArray(existing)
      ? existing.find((c) => (c.body ?? "").includes(markerFor()))
      : undefined;
    const url = mine
      ? `https://api.github.com/repos/${repo}/issues/comments/${mine.id}`
      : api;
    const res = await fetch(url, {
      method: mine ? "PATCH" : "POST",
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) log("warning", `could not post the comment: ${res.status} ${await res.text()}`);
    else log("notice", mine ? "updated the existing preflight comment" : "posted a preflight comment");
  } catch (e) {
    log("warning", `could not post the comment: ${(e as Error).message}`);
  }
}

async function main(): Promise<number> {
  const patterns = env("PREFLIGHT_PATHS", ".claude/workflows/**,**/*.graph.json,**/*.spec.json")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const configPath = env("PREFLIGHT_CONFIG", "preflight.json");
  const overrides: Partial<Assumptions> = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as Partial<Assumptions>)
    : {};

  const specs = findSpecs(patterns);
  if (!specs.length) {
    log("notice", `preflight: no workflow specs matched ${patterns.join(", ")}`);
    setOutput("usd", "0");
    setOutput("agents", "0");
    return 0;
  }

  const base = env("PREFLIGHT_BASE");
  const bodies: string[] = [];
  let totalUsd = 0;
  let totalAgents = 0;

  for (const file of specs) {
    let after: Estimate;
    try {
      after = estimate(read(file, readFileSync(file, "utf8")), overrides);
    } catch (e) {
      log("warning", `preflight: skipped ${file}: ${(e as Error).message}`);
      continue;
    }
    totalUsd += after.usd.expected;
    totalAgents += after.agents.expected;
    bodies.push(markdown(diffEstimates(atBase(base, file, overrides), after), { file }));
  }

  setOutput("usd", totalUsd.toFixed(2));
  setOutput("agents", String(totalAgents));

  if (env("PREFLIGHT_COMMENT", "true") === "true" && bodies.length) {
    await upsertComment(bodies.join("\n\n---\n\n"));
  } else {
    console.log(bodies.join("\n\n---\n\n"));
  }

  const cap = env("PREFLIGHT_MAX_USD");
  if (cap && totalUsd > Number(cap)) {
    log("error", `expected cost $${totalUsd.toFixed(2)} exceeds max-usd ${cap}`);
    return 1;
  }
  log("notice", `preflight: ${totalAgents} agents, $${totalUsd.toFixed(2)} expected across ${specs.length} spec(s)`);
  return 0;
}

main().then((c) => {
  process.exitCode = c;
});
