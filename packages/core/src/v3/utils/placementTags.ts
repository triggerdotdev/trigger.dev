import { type PlacementTag } from "../schemas/index.js";
import { SimpleStructuredLogger } from "./structuredLogger.js";

export interface PlacementConfig {
  enabled: boolean;
  prefix: string;
}

export class PlacementTagProcessor {
  private readonly logger = new SimpleStructuredLogger("placement-tag-processor");

  constructor(private readonly config: PlacementConfig) {}

  /**
   * Converts placement tags to Kubernetes nodeSelector labels
   */
  convertToNodeSelector(
    placementTags?: PlacementTag[],
    existingNodeSelector?: Record<string, string>
  ): Record<string, string> {
    if (!this.config.enabled || !placementTags || placementTags.length === 0) {
      return existingNodeSelector ?? {};
    }

    const nodeSelector: Record<string, string> = { ...existingNodeSelector };

    // Convert placement tags to nodeSelector labels
    for (const tag of placementTags) {
      const labelKey = `${this.config.prefix}/${tag.key}`;

      // Print warnings (if any)
      this.printTagWarnings(tag);

      // For now we only support single values via nodeSelector
      nodeSelector[labelKey] = tag.values?.[0] ?? "";
    }

    return nodeSelector;
  }

  private printTagWarnings(tag: PlacementTag) {
    if (!tag.values || tag.values.length === 0) {
      // No values provided
      this.logger.warn(
        "Placement tag has no values, using empty string",
        tag
      );
    } else if (tag.values.length > 1) {
      // Multiple values provided
      this.logger.warn(
        "Placement tag has multiple values, only using first one",
        tag
      );
    }
  }
}

/**
 * Helper function to create a placement tag. In the future this will be able to support multiple values and operators.
 * For now it's just a single value.
 */
export function placementTag(key: string, value: string): PlacementTag {
  return { key, values: [value] };
}