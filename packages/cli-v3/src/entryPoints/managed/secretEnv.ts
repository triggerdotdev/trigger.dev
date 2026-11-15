/**
 * Holds an attempt's env values in Buffers that can be zeroed, so the controller keeps no long-lived
 * strings of them. Strings made by `toRecord()` stay in the heap until garbage collected.
 */
export class SecretEnv {
  private entries: Array<[string, Buffer]>;

  private constructor(entries: Array<[string, Buffer]>) {
    this.entries = entries;
  }

  /** Moves the values out of `env`, deleting its keys so it no longer references them. */
  static takeFrom(env: Record<string, string>): SecretEnv {
    const entries: Array<[string, Buffer]> = [];
    for (const key of Object.keys(env)) {
      entries.push([key, Buffer.from(env[key] ?? "", "utf8")]);
      delete env[key];
    }
    return new SecretEnv(entries);
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.entries.map(([key, value]) => [key, value.toString("utf8")]));
  }

  zero(): void {
    for (const [, value] of this.entries) {
      value.fill(0);
    }
    this.entries = [];
  }
}
