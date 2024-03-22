import { dependencies } from "../../../package.json"

export function detectDependencyVersion(dependency: string): string | undefined {
  return (dependencies as Record<string, string>)[dependency]
}