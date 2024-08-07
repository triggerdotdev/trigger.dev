export function resolveModule(moduleName: string) {
  // @ts-ignore
  return require.resolve(moduleName);
}
