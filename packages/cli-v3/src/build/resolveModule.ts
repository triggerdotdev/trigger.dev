// @ts-ignore
import { resolvePath } from "mlly";

export function resolveModule(moduleName: string, url?: string) {
  return resolvePath(moduleName, {
    // @ts-ignore
    url: url ?? import.meta.url,
  });
}
