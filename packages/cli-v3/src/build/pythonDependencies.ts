/**
 * Parse and manage Python dependencies.
 */

export interface PythonDependency {
  name: string;
  version?: string;
  extras?: string[];
}

/**
 * Parse requirements.txt content into structured dependencies.
 * Supports syntax: package[extra1,extra2]==version
 * Package names must follow PEP 508: start with letter or underscore, followed by letters, digits, hyphens, or underscores
 */
export function parseRequirementsTxt(content: string): PythonDependency[] {
  const lines = content.split("\n");
  const dependencies: PythonDependency[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Parse dependency in format: package[extra1,extra2]==version
    // Full regex for package name: [A-Za-z_][A-Za-z0-9_-]*
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\[([^\]]+)\])?(?:([<>=!~]+)(.+))?$/);

    if (match) {
      const [, name, extras, operator, version] = match;

      dependencies.push({
        name: name.trim(),
        extras: extras?.split(",").map((e) => e.trim()),
        version: version ? `${operator}${version.trim()}` : undefined,
      });
    } else {
      // Try simple package name (reusing the same regex pattern)
      const simpleMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)/);
      if (simpleMatch) {
        dependencies.push({
          name: simpleMatch[1],
        });
      }
    }
  }

  return dependencies;
}

/**
 * Generate requirements.txt content from dependency objects.
 */
export function generateRequirementsTxt(dependencies: PythonDependency[]): string {
  return dependencies
    .map((dep) => {
      let line = dep.name;
      if (dep.extras?.length) {
        line += `[${dep.extras.join(",")}]`;
      }
      if (dep.version) {
        line += dep.version;
      }
      return line;
    })
    .join("\n");
}

/**
 * Validate requirements.txt syntax.
 * Returns parsing errors if any.
 */
export function validateRequirementsTxt(content: string): { valid: boolean; errors: string[] } {
  const lines = content.split("\n");
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    // Try to parse the line
    try {
      const match = line.match(/^(\w[\w\-]*)(?:\[([^\]]+)\])?(?:([<>=!~]+)(.+))?$/);
      if (!match) {
        // Try simple package name
        const simpleMatch = line.match(/^(\w[\w\-]*)/);
        if (!simpleMatch) {
          errors.push(`Line ${i + 1}: Invalid format "${line}"`);
        }
      }
    } catch (error) {
      errors.push(`Line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
