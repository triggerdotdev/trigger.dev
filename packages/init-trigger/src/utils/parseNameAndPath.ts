import pathModule from "path";

// Takes a relative path (like .) and resolves it to a full path (like /Users/username/Projects/my-triggers)
export const resolvePath = (input: string) => {
  return pathModule.resolve(process.cwd(), input);
};
