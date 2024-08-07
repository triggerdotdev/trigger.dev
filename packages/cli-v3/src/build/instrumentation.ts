import { InstrumentationModuleDefinition } from "@opentelemetry/instrumentation";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { builtinModules } from "node:module";

export function getInstrumentedPackageNames(
  config: ResolvedConfig
): Array<string> {
  const packageNames = [];

  if (config.instrumentations) {
    for (const instrumentation of config.instrumentations) {
      const moduleDefinitions = (
        instrumentation as any
      ).getModuleDefinitions?.() as Array<InstrumentationModuleDefinition>;

      if (!Array.isArray(moduleDefinitions)) {
        continue
      }

      for (const moduleDefinition of moduleDefinitions) {
        if (!builtinModules.includes(moduleDefinition.name)) {
          packageNames.push(moduleDefinition.name);
        }
      }
    }
  }

  return packageNames;
}
