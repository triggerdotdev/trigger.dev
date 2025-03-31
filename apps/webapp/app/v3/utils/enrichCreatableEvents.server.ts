import type { CreatableEvent } from "../eventRepository.server";

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
  const baseStyle = event.style ?? {};
  const props = event.properties;

  // Direct property access and early returns
  // GenAI System check
  const system = props["gen_ai.system"];
  if (typeof system === "string") {
    return { ...baseStyle, icon: `tabler-brand-${system}` };
  }

  // Agent workflow check
  const name = props["name"];
  if (typeof name === "string" && name.includes("Agent workflow")) {
    return { ...baseStyle, icon: "tabler-brain" };
  }

  return baseStyle;
}

function repr(value: any): string {
  if (typeof value === "string") {
    return `'${value}'`;
  }
  return String(value);
}

function formatPythonStyle(template: string, values: Record<string, any>): string {
  // Early return if template is too long
  if (template.length >= 256) {
    return template;
  }

  // Early return if no template variables present
  if (!template.includes("{")) {
    return template;
  }

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
