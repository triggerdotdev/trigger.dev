import { type EnvironmentVariable } from "./environmentVariables/repository";

/** Later variables override earlier ones */
export function deduplicateVariableArray(variables: EnvironmentVariable[]) {
  const result: EnvironmentVariable[] = [];
  // Process array in reverse order so later variables override earlier ones
  for (const variable of [...variables].reverse()) {
    if (!result.some((v) => v.key === variable.key)) {
      result.push(variable);
    }
  }
  // Reverse back to maintain original order but with later variables taking precedence
  return result.reverse();
}
