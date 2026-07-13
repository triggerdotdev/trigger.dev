import { describe, it, expect } from "vitest";
import { enrichCreatableEvents, setLlmPricingRegistry } from "./enrichCreatableEvents.server";
import type { CreateEventInput } from "../eventRepository/eventRepository.types";

type Registry = Parameters<typeof setLlmPricingRegistry>[0];
type RegistryCost = NonNullable<ReturnType<Registry["calculateCost"]>>;

function registryReturning(cost: RegistryCost | null, isLoaded = true): Registry {
  return {
    isLoaded,
    calculateCost: () => cost,
  };
}

// A catalog cost result the registry would produce. The numbers here stand in for a catalog
// price that disagrees with what the provider actually billed.
function catalogCost(overrides: Partial<RegistryCost> = {}): RegistryCost {
  return {
    matchedModelId: "llm_model_test",
    matchedModelName: "test-model",
    pricingTierId: "tier_standard",
    pricingTierName: "Standard",
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    costDetails: {},
    ...overrides,
  };
}

function makeEvent(properties: Record<string, unknown>): CreateEventInput {
  return {
    message: "ai.generateText.doGenerate",
    kind: "INTERNAL",
    isPartial: false,
    properties: properties as CreateEventInput["properties"],
  } as unknown as CreateEventInput;
}

function enrichOne(event: CreateEventInput): CreateEventInput {
  const [out] = enrichCreatableEvents([event]);
  return out;
}

function costPillText(event: CreateEventInput): string | undefined {
  const accessory = (event.style as any)?.accessory;
  const items: Array<{ text: string; icon: string }> = accessory?.items ?? [];
  return items.find((i) => i.icon === "tabler-currency-dollar")?.text;
}

function modelPillText(event: CreateEventInput): string | undefined {
  const accessory = (event.style as any)?.accessory;
  const items: Array<{ text: string; icon: string }> = accessory?.items ?? [];
  return items.find((i) => i.icon === "tabler-cube")?.text;
}

describe("enrichLlmMetrics — provider-reported cost", () => {
  it("prefers the provider-reported cost over catalog pricing when a cache discount applies", () => {
    // OpenRouter served mimo with 25,280 of 34,374 prompt tokens as cache reads. Cache counts
    // only reach us via providerMetadata, so the catalog bills the full prompt at the input
    // rate while OpenRouter's exact bill reflects the cache discount.
    setLlmPricingRegistry(registryReturning(catalogCost({ totalCost: 0.01603584 })));

    const out = enrichOne(
      makeEvent({
        "gen_ai.system": "openrouter",
        "gen_ai.request.model": "xiaomi/mimo-v2.5-pro",
        "gen_ai.response.model": "xiaomi/mimo-v2.5-pro-20260422",
        "gen_ai.usage.input_tokens": 34374,
        "gen_ai.usage.output_tokens": 1245,
        "ai.response.providerMetadata": JSON.stringify({
          openrouter: {
            provider: "Xiaomi",
            usage: { cost: 0.005130048, promptTokensDetails: { cachedTokens: 25280 } },
          },
        }),
      })
    );

    expect(out.properties["trigger.llm.total_cost"]).toBe(0.005130048);
    expect(out.properties["trigger.llm.cost_source"]).toBe("openrouter");
    // The catalog breakdown must not be written — it priced the wrong (full-rate) total.
    expect(out.properties["trigger.llm.input_cost"]).toBeUndefined();
    expect(out.properties["trigger.llm.matched_model"]).toBeUndefined();
    expect(costPillText(out)).toBe("$0.005130");

    expect(out._llmMetrics?.totalCost).toBe(0.005130048);
    expect(out._llmMetrics?.costSource).toBe("openrouter");
    expect(out._llmMetrics?.providerCost).toBe(0.005130048);
    expect(out._llmMetrics?.inputCost).toBe(0);
  });

  it("prices the served fallback model's provider cost, not the requested model", () => {
    // Requested mimo, OpenRouter routed to a gemini fallback: gen_ai.response.model carries the
    // SERVED model, and the provider cost is authoritative.
    setLlmPricingRegistry(registryReturning(catalogCost({ totalCost: 0.02 })));

    const out = enrichOne(
      makeEvent({
        "gen_ai.system": "openrouter",
        "gen_ai.request.model": "xiaomi/mimo-v2.5-pro",
        "gen_ai.response.model": "google/gemini-3.5-flash-20260519",
        "gen_ai.usage.input_tokens": 5000,
        "gen_ai.usage.output_tokens": 800,
        "ai.response.providerMetadata": JSON.stringify({
          openrouter: { provider: "Google", usage: { cost: 0.011058 } },
        }),
      })
    );

    expect(out.properties["trigger.llm.total_cost"]).toBe(0.011058);
    expect(out.properties["trigger.llm.cost_source"]).toBe("openrouter");
    // The pill (and stored response model) reflect the served fallback model.
    expect(modelPillText(out)).toBe("google/gemini-3.5-flash-20260519");
    expect(out._llmMetrics?.requestModel).toBe("xiaomi/mimo-v2.5-pro");
    expect(out._llmMetrics?.responseModel).toBe("google/gemini-3.5-flash-20260519");
    expect(out._llmMetrics?.totalCost).toBe(0.011058);
  });

  it("prefers the gateway-reported cost over catalog pricing", () => {
    setLlmPricingRegistry(registryReturning(catalogCost({ totalCost: 0.02 })));

    const out = enrichOne(
      makeEvent({
        "gen_ai.system": "gateway",
        "gen_ai.response.model": "openai/gpt-4o",
        "gen_ai.usage.input_tokens": 1000,
        "gen_ai.usage.output_tokens": 500,
        "ai.response.providerMetadata": JSON.stringify({
          gateway: { cost: "0.0006615" },
        }),
      })
    );

    expect(out.properties["trigger.llm.total_cost"]).toBe(0.0006615);
    expect(out.properties["trigger.llm.cost_source"]).toBe("gateway");
    expect(out._llmMetrics?.costSource).toBe("gateway");
  });

  it("uses provider cost even when the catalog does not match the model", () => {
    setLlmPricingRegistry(registryReturning(null));

    const out = enrichOne(
      makeEvent({
        "gen_ai.system": "openrouter",
        "gen_ai.response.model": "some/unlisted-model",
        "gen_ai.usage.input_tokens": 2000,
        "gen_ai.usage.output_tokens": 300,
        "ai.response.providerMetadata": JSON.stringify({
          openrouter: { provider: "SomeProvider", usage: { cost: 0.00042 } },
        }),
      })
    );

    expect(out.properties["trigger.llm.total_cost"]).toBe(0.00042);
    expect(out.properties["trigger.llm.cost_source"]).toBe("openrouter");
  });

  it("falls back to catalog pricing when no provider cost is reported", () => {
    setLlmPricingRegistry(
      registryReturning(
        catalogCost({
          matchedModelId: "llm_model_gpt4o",
          matchedModelName: "gpt-4o",
          inputCost: 0.04,
          outputCost: 0.01,
          totalCost: 0.05,
          costDetails: { input: 0.04, output: 0.01 },
        })
      )
    );

    const out = enrichOne(
      makeEvent({
        "gen_ai.system": "openai",
        "gen_ai.response.model": "gpt-4o",
        "gen_ai.usage.input_tokens": 1000,
        "gen_ai.usage.output_tokens": 500,
      })
    );

    expect(out.properties["trigger.llm.total_cost"]).toBe(0.05);
    expect(out.properties["trigger.llm.input_cost"]).toBe(0.04);
    expect(out.properties["trigger.llm.output_cost"]).toBe(0.01);
    expect(out.properties["trigger.llm.matched_model"]).toBe("gpt-4o");
    // Registry path does not set a cost_source attribute.
    expect(out.properties["trigger.llm.cost_source"]).toBeUndefined();
    expect(out._llmMetrics?.costSource).toBe("registry");
    expect(out._llmMetrics?.matchedModelId).toBe("llm_model_gpt4o");
  });

  it("falls back to catalog pricing when providerMetadata carries no cost field", () => {
    // The cheap `"cost"` guard should skip parsing and let the registry price this span.
    setLlmPricingRegistry(
      registryReturning(catalogCost({ totalCost: 0.03, matchedModelName: "claude" }))
    );

    const out = enrichOne(
      makeEvent({
        "gen_ai.system": "anthropic",
        "gen_ai.response.model": "claude-sonnet-4-0",
        "gen_ai.usage.input_tokens": 1000,
        "gen_ai.usage.output_tokens": 500,
        "ai.response.providerMetadata": JSON.stringify({
          anthropic: { usage: { service_tier: "standard" } },
        }),
      })
    );

    expect(out.properties["trigger.llm.total_cost"]).toBe(0.03);
    expect(out.properties["trigger.llm.cost_source"]).toBeUndefined();
    expect(out._llmMetrics?.costSource).toBe("registry");
  });
});
