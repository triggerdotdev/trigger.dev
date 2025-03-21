export function singleton<T>(name: string, getValue: () => T): T {
  const thusly = globalThis as unknown as {
    __trigger_singletons: Record<string, T>;
  };
  thusly.__trigger_singletons ??= {};
  thusly.__trigger_singletons[name] ??= getValue();
  return thusly.__trigger_singletons[name];
}
