import pathModule from "path";

/**
 * Parses the projectName and its path from the user input.
 *
 * Returns a tuple of of `[projectName, path]`, where `projectName` is the name put in the "package.json"
 * file and `path` is the path to the directory where the project will be created.
 *
 * If `projectName` is ".", the name of the directory will be used instead. Handles the case where the
 * input includes a scoped package name in which case that is being parsed as the name, but not
 * included as the path.
 *
 * For example:
 *
 * - dir/@mono/app => ["@mono/app", "dir/app"]
 * - dir/app => ["app", "dir/app"]
 */
export const parseNameAndPath = (input: string) => {
  const paths = input.split("/");

  let projectName = paths[paths.length - 1];

  // If the user ran `npx create-t3-app .` or similar, the projectName should be the current directory
  if (projectName === ".") {
    const parsedCwd = pathModule.resolve(process.cwd());
    projectName = pathModule.basename(parsedCwd);
  }

  // If the first part is a @, it's a scoped package
  const indexOfDelimiter = paths.findIndex((p) => p.startsWith("@"));
  if (paths.findIndex((p) => p.startsWith("@")) !== -1) {
    projectName = paths.slice(indexOfDelimiter).join("/");
  }

  const path = paths.filter((p) => !p.startsWith("@")).join("/");

  return [projectName, path] as const;
};
