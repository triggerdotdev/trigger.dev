import { describe, expect, it } from "vitest";
import {
  pickStartupOnlyEnv,
  startupOnlyEnvNotApplied,
  startupOnlyEnvWarning,
} from "./startupEnv.js";

describe("startupOnlyEnvNotApplied", () => {
  // Catches: a run's startup-only settings silently not applying because they arrive after the process starts.
  it("names the startup-only vars the process did not start with", () => {
    const startupEnv = pickStartupOnlyEnv({
      LD_LIBRARY_PATH: "/app/lib",
      NODE_OPTIONS: "--max-old-space-size=1024",
      TRIGGER_PROJECT_REF: "proj_abc",
    });

    expect(
      startupOnlyEnvNotApplied(startupEnv, {
        LD_LIBRARY_PATH: "/app/lib",
        NODE_OPTIONS: "--require ./setup.js",
        MALLOC_ARENA_MAX: "2",
        UV_USE_IO_URING: "0",
        GLIBC_TUNABLES: "glibc.malloc.trim_threshold=0",
        TZ: "Europe/London",
        TRIGGER_SECRET_KEY: "secret",
        DATABASE_URL: "postgres://user:pass@db/app",
      })
    ).toEqual(["GLIBC_TUNABLES", "MALLOC_ARENA_MAX", "NODE_OPTIONS", "UV_USE_IO_URING"]);
  });

  // Catches: the warning leaking a variable's value into the run's logs.
  it("names the variables without their values", () => {
    const names = startupOnlyEnvNotApplied({}, { MALLOC_ARENA_MAX: "secret-looking-value" });

    expect(startupOnlyEnvWarning(names)).toContain("MALLOC_ARENA_MAX");
    expect(startupOnlyEnvWarning(names)).not.toContain("secret-looking-value");
  });
});
