import { formatNumberCompact } from "./numberFormatter";

/** Format a per-token price as $/1M tokens. */
export function formatModelPrice(pricePerToken: number | null): string {
  if (pricePerToken === null) return "—";
  const perMillion = pricePerToken * 1_000_000;
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}`;
  if (perMillion < 1) return `$${perMillion.toFixed(3)}`;
  return `$${perMillion.toFixed(2)}`;
}

/** Format a token count (context window, max output). */
export function formatTokenCount(tokens: number | null): string {
  if (tokens === null) return "—";
  return formatNumberCompact(tokens);
}

/** Format a dollar cost value. */
export function formatModelCost(dollars: number): string {
  if (dollars === 0) return "$0";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Format a feature slug (snake_case) to Title Case. */
export function formatFeature(slug: string): string {
  return slug
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** @deprecated Use formatFeature instead. */
export const formatCapability = formatFeature;

/** Capitalize a provider name. */
export function formatProviderName(provider: string): string {
  const names: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    meta: "Meta",
    mistral: "Mistral",
    cohere: "Cohere",
    ai21: "AI21",
    amazon: "Amazon",
    xai: "xAI",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    perplexity: "Perplexity",
    nous: "Nous",
  };
  return names[provider.toLowerCase()] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}
