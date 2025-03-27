import type { CreatableEvent } from "../eventRepository.server";

type StyleEnricher = {
  name: string;
  condition: (event: CreatableEvent) => boolean;
  enrich: (event: CreatableEvent) => Record<string, string> | undefined;
};

// Define our style enrichers
const styleEnrichers: StyleEnricher[] = [
  {
    name: "GenAI System",
    condition: (event) => typeof event.properties["gen_ai.system"] === "string",
    enrich: (event) => ({
      icon: `tabler-brand-${event.properties["gen_ai.system"]}`,
    }),
  },
  {
    name: "Agent workflow",
    condition: (event) =>
      typeof event.properties["name"] === "string" &&
      event.properties["name"].includes("Agent workflow"),
    enrich: () => ({
      icon: "tabler-brain",
    }),
  },
];

export function enrichCreatableEvents(events: CreatableEvent[]) {
  return events.map((event) => {
    return enrichCreatableEvent(event);
  });
}

function enrichCreatableEvent(event: CreatableEvent): CreatableEvent {
  const message = formatPythonStyle(event.message, event.properties);

  event.message = message;
  event.style = enrichStyle(event);

  return event;
}

function enrichStyle(event: CreatableEvent) {
  // Keep existing style properties as base
  const baseStyle = event.style ?? {};

  // Find the first matching enricher
  for (const enricher of styleEnrichers) {
    if (enricher.condition(event)) {
      const enrichedStyle = enricher.enrich(event);
      if (enrichedStyle) {
        return {
          ...baseStyle,
          ...enrichedStyle,
        };
      }
    }
  }

  // Return original style if no enricher matched
  return baseStyle;
}

function repr(value: any): string {
  if (typeof value === "string") {
    return `'${value}'`;
  }
  return String(value);
}

function formatPythonStyle(template: string, values: Record<string, any>): string {
  return template.replace(/\{([^}]+?)(?:!r)?\}/g, (match, key) => {
    const hasRepr = match.endsWith("!r}");
    const actualKey = hasRepr ? key : key;
    const value = values[actualKey];

    if (value === undefined) {
      return match;
    }

    return hasRepr ? repr(value) : String(value);
  });
}
