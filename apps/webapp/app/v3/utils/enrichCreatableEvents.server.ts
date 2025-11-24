import { accessoryAttributes, flattenAttributes } from "@trigger.dev/core/v3";
import type { CreateEventInput } from "../eventRepository/eventRepository.types";

export function enrichCreatableEvents(events: CreateEventInput[]) {
  return events.map((event) => {
    return enrichCreatableEvent(event);
  });
}

function enrichCreatableEvent(event: CreateEventInput): CreateEventInput {
  const message = formatPythonStyle(event.message, event.properties);

  event.message = message;
  event.style = enrichStyle(event);

  return event;
}

function enrichStyle(event: CreateEventInput) {
  const baseStyle = event.style ?? {};
  const props = event.properties;

  if (!props) {
    return baseStyle;
  }

  if (event.message === "prisma:client:operation") {
    const operationName = props["name"];

    if (typeof operationName === "string") {
      return {
        ...baseStyle,
        ...flattenAttributes(
          {
            items: [
              {
                text: operationName,
                variant: "normal",
              },
            ],
            style: "codepath",
          },
          "accessory"
        ),
      };
    }

    return { ...baseStyle };
  }

  // Direct property access and early returns
  // GenAI System check
  const system = props["gen_ai.system"];
  if (typeof system === "string") {
    return { ...baseStyle, icon: `tabler-brand-${system.split(".")[0]}` };
  }

  // Agent workflow check
  const name = props["name"];
  if (typeof name === "string" && name.includes("Agent workflow")) {
    return { ...baseStyle, icon: "tabler-brain" };
  }

  const message = event.message;

  if (typeof message === "string" && message === "ai.toolCall") {
    return { ...baseStyle, icon: "tabler-tool" };
  }

  if (typeof message === "string" && message.startsWith("ai.")) {
    return { ...baseStyle, icon: "tabler-sparkles" };
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
    const value = values?.[actualKey];

    if (value === undefined) {
      return match;
    }

    return hasRepr ? repr(value) : String(value);
  });
}
