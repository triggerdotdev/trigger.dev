import { DisplayProperty, DisplayPropertiesSchema } from "@trigger.dev/core";

// Takes a list of potential arrays of DisplayProperties and merges them together so no duplicates exist based on the label
// For example, if the propertyLists are:
// [
//   [{label: "foo", value: "bar"}],
//   [{label: "foo", value: "baz"}],
//   [{label: "bar", value: "baz"}],
// ]
// The result would be:
// [
//   {label: "foo", value: "baz"},
//   {label: "bar", value: "baz"},
// ]
//
// We will use the DisplayPropertiesSchema zod schema to safely parse the properties and if they aren't valid then we'll just ignore them
export function mergeProperties(...propertyLists: Array<unknown>): Array<DisplayProperty> {
  const mergedProperties = new Map<string, DisplayProperty>();

  for (const propertyList of propertyLists) {
    const properties = DisplayPropertiesSchema.safeParse(propertyList);

    if (properties.success) {
      for (const property of properties.data) {
        mergedProperties.set(property.label, property);
      }
    }
  }

  return Array.from(mergedProperties.values());
}
