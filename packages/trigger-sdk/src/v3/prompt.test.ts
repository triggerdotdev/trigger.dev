import { describe, expect, it } from "vitest";
import { definePrompt } from "./prompt.js";

describe("local prompt resolution", () => {
  // Catches: values inserted inside conditional sections being evaluated again as placeholders.
  it("keeps substituted template syntax literal inside and outside conditionals", async () => {
    const prompt = definePrompt({
      id: "literal-prompt-values",
      content: "{{#show}}Hello {{name}} / {{ name }}!{{/show}} Outside: {{name}}",
    });

    const result = await prompt.resolve({
      show: true,
      name: "{{systemPrompt}}",
      systemPrompt: "private instructions",
    });

    expect(result.text).toBe(
      "Hello {{systemPrompt}} / {{systemPrompt}}! Outside: {{systemPrompt}}"
    );
  });

  // Catches: inherited Object.prototype properties resolving as values or enabling conditionals.
  it.each(["constructor", "__proto__", "toString"])(
    "does not resolve inherited %s properties",
    async (key) => {
      const prompt = definePrompt({
        id: `inherited-prompt-${key}`,
        content: `Before{{${key}}}{{#${key}}}hidden{{/${key}}}After`,
      });

      expect((await prompt.resolve({})).text).toBe("BeforeAfter");
    }
  );

  // Catches: custom prototype values being substituted, including inside enabled sections.
  it("ignores custom inherited properties and supports shadowed hasOwnProperty", async () => {
    const variables = Object.assign(Object.create({ inherited: "private" }), {
      show: true,
      hasOwnProperty: "own value",
    });
    const prompt = definePrompt({
      id: "custom-prototype-prompt",
      content:
        "{{inherited}}{{#inherited}}hidden{{/inherited}}{{#show}}{{inherited}}{{hasOwnProperty}}{{/show}}",
    });

    expect((await prompt.resolve(variables)).text).toBe("own value");
  });

  // Catches: own properties with prototype-related names being incorrectly rejected.
  it("resolves explicitly supplied prototype-related names on a null-prototype object", async () => {
    const variables = Object.assign(Object.create(null), {
      constructor: "own constructor",
      ["__proto__"]: "own proto",
    });
    const prompt = definePrompt({
      id: "own-prototype-names-prompt",
      content: "{{constructor}} / {{#__proto__}}{{ __proto__ }}{{/__proto__}}",
    });

    expect((await prompt.resolve(variables)).text).toBe("own constructor / own proto");
  });

  // Catches: conditional selection or ordinary substitution changing during compiler refactoring.
  it("preserves conditionals, whitespace, missing values, and falsy substitutions", async () => {
    const prompt = definePrompt({
      id: "ordinary-prompt-substitutions",
      content:
        "{{#show}}Hello {{ name }}: {{count}} / {{enabled}} / {{nil}} / {{missing}}{{/show}}" +
        "{{#disabled}}hidden{{/disabled}}{{#missing}}hidden{{/missing}} Outside: {{name}}",
    });

    const result = await prompt.resolve({
      show: true,
      name: "Ada",
      count: 0,
      enabled: false,
      nil: null,
      disabled: false,
    });

    expect(result.text).toBe("Hello Ada: 0 / false /  /  Outside: Ada");
  });
});
