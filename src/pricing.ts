/**
 * Model prices, in USD per million tokens.
 *
 * These are Anthropic first-party API list rates. They are a *cache* — they go
 * stale, and a cost estimator quoting stale prices is worse than one that admits
 * it does not know. So every entry carries the date it was verified, and
 * `preflight estimate` prints that date in its footer. `PRICING_VERIFIED` is
 * asserted in CI against a maximum age so a forgotten table becomes a failing
 * build rather than a wrong invoice.
 *
 * Override any of this with a `preflight.json` in your repo — see `loadPricing`.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** Context window, in tokens. Used to warn about oversized fan-in payloads. */
  context: number;
  /** Which cost tier this model belongs to in a tiered graph. */
  tier: "cheap" | "standard" | "deep";
  /** Set when the listed price is promotional and will rise. */
  introUntil?: string;
  /** The standard price this reverts to when `introUntil` passes. */
  standardInput?: number;
  standardOutput?: number;
}

export const PRICING_VERIFIED = "2026-06-24";

export const PRICING: Record<string, ModelPrice> = {
  "claude-fable-5": { input: 10, output: 50, context: 1_000_000, tier: "deep" },
  "claude-mythos-5": { input: 10, output: 50, context: 1_000_000, tier: "deep" },
  "claude-opus-5": { input: 5, output: 25, context: 1_000_000, tier: "deep" },
  "claude-opus-4-8": { input: 5, output: 25, context: 1_000_000, tier: "deep" },
  "claude-opus-4-7": { input: 5, output: 25, context: 1_000_000, tier: "deep" },
  "claude-opus-4-6": { input: 5, output: 25, context: 1_000_000, tier: "deep" },
  "claude-sonnet-5": {
    // Introductory pricing. The estimator uses the standard rate for any run
    // dated after the intro window, because quoting $2/$10 for a workflow that
    // will actually run in September is the kind of "helpful" rounding that
    // makes a cost tool untrustworthy.
    input: 2,
    output: 10,
    context: 1_000_000,
    tier: "standard",
    introUntil: "2026-08-31",
    standardInput: 3,
    standardOutput: 15,
  },
  "claude-sonnet-4-6": { input: 3, output: 15, context: 1_000_000, tier: "standard" },
  "claude-haiku-4-5": { input: 1, output: 5, context: 200_000, tier: "cheap" },
};

/** The model assumed for each tier when a spec names a tier but not a model. */
export const TIER_DEFAULT: Record<ModelPrice["tier"], string> = {
  cheap: "claude-haiku-4-5",
  standard: "claude-sonnet-5",
  deep: "claude-opus-5",
};

/**
 * What an untiered node costs. A node with no `model` inherits the session
 * model, and the session model in practice is whatever the operator is running —
 * usually the deep tier. Assuming cheap here would make every unfixed graph look
 * free, which is the opposite of useful.
 */
export const UNTIERED_ASSUMPTION = "claude-opus-5";

/** Resolve a model id or alias to a price, tolerating partial names. */
export function priceOf(model: string | null | undefined, asOf?: string): ModelPrice & { model: string } {
  const id = resolveModel(model);
  const p = PRICING[id]!;
  // Apply the standard rate once the intro window has passed.
  if (p.introUntil && asOf && asOf > p.introUntil) {
    return {
      ...p,
      model: id,
      input: p.standardInput ?? p.input,
      output: p.standardOutput ?? p.output,
    };
  }
  return { ...p, model: id };
}

export function resolveModel(model: string | null | undefined): string {
  if (!model) return UNTIERED_ASSUMPTION;
  if (PRICING[model]) return model;
  const lower = model.toLowerCase();
  // Longest match first, so `claude-opus-4-8` wins over `opus`.
  const exact = Object.keys(PRICING)
    .sort((a, b) => b.length - a.length)
    .find((k) => lower.includes(k));
  if (exact) return exact;
  if (lower.includes("fable") || lower.includes("mythos")) return "claude-fable-5";
  if (lower.includes("opus")) return "claude-opus-5";
  if (lower.includes("sonnet")) return "claude-sonnet-5";
  if (lower.includes("haiku")) return "claude-haiku-4-5";
  return UNTIERED_ASSUMPTION;
}

export function knownModels(): string[] {
  return Object.keys(PRICING);
}

/** Days since the pricing table was verified. CI asserts a ceiling on this. */
export function pricingAgeDays(today: string): number {
  const then = Date.parse(`${PRICING_VERIFIED}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  return Math.floor((now - then) / 86_400_000);
}

/**
 * Render the table as an `OTTER_MODEL_PRICING` value.
 *
 * Otter (the orchestration engine in the Kymatics stack) reads its price list
 * from that environment variable as a comma-separated `model=input:output`,
 * both USD per million tokens — the same numbers this module keeps, in a
 * different shape. Emitting it from here gives the two systems one source of
 * truth, and it is the CI-checked one: `PRICING_VERIFIED` fails the build when
 * the table goes stale, whereas a hand-set env var rots silently.
 *
 * `asOf` matters: an intro rate that has expired must not be exported as if it
 * were current, or Otter's post-hoc cost reporting would under-report.
 */
export function toOtterEnv(asOf?: string): string {
  return Object.keys(PRICING)
    .map((id) => {
      const p = priceOf(id, asOf);
      return `${id}=${p.input}:${p.output}`;
    })
    .join(",");
}
