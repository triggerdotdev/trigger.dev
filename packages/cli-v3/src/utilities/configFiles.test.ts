import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { xdgAppPaths } from "../imports/xdg-app-paths.js";
import {
  readAuthConfigFile,
  writeAuthConfigCurrentProfileName,
  writeAuthConfigProfile,
  writeConfigHasSeenMCPInstallPrompt,
  writePendingAuthorization,
} from "./configFiles.js";

describe.skipIf(process.platform === "win32")("auth config permissions", () => {
  let tempDir: string;
  let configDir: string;
  let configFile: string;
  let previousConfigHome: string | undefined;
  let previousHome: string | undefined;
  let previousUmask: number;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "trigger-auth-config-"));
    previousConfigHome = process.env.XDG_CONFIG_HOME;
    previousHome = process.env.HOME;
    process.env.XDG_CONFIG_HOME = tempDir;
    process.env.HOME = tempDir;
    previousUmask = process.umask(0o022);
    configDir = xdgAppPaths("trigger").config();
    configFile = path.join(configDir, "config.json");
    expect(configDir.startsWith(`${tempDir}${path.sep}`)).toBe(true);
  });

  afterEach(() => {
    process.umask(previousUmask);
    if (previousConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates owner-only directories and credential files under a typical umask", () => {
    writeAuthConfigProfile({ accessToken: "test-token", apiUrl: "https://api.example.com" });

    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect(readAuthConfigFile()?.profiles.default?.accessToken).toBe("test-token");
  });

  it("protects pending authorization files before an access token exists", () => {
    const pendingAuthorization = {
      authorizationCode: "test-authorization-code",
      url: "https://example.com/authorize",
      apiUrl: "https://api.example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    writePendingAuthorization(pendingAuthorization);

    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect(readAuthConfigFile()?.profiles.default?.pendingAuthorization).toEqual(
      pendingAuthorization
    );
  });

  it.each([
    ["profile", () => writeAuthConfigProfile({ accessToken: "updated-test-token" }, "staging")],
    ["current profile", () => writeAuthConfigCurrentProfileName("staging")],
    ["settings", () => writeConfigHasSeenMCPInstallPrompt(true)],
  ] as const)("tightens existing permissions on a %s rewrite", (_name, rewrite) => {
    writeAuthConfigProfile({ accessToken: "test-token" });
    const oldConfigFile = path.join(configDir, "default.json");
    writeFileSync(oldConfigFile, JSON.stringify({ default: { accessToken: "legacy-test-token" } }));
    chmodSync(configDir, 0o755);
    chmodSync(configFile, 0o644);
    chmodSync(oldConfigFile, 0o644);

    rewrite();

    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect(statSync(oldConfigFile).mode & 0o777).toBe(0o600);
    expect(readAuthConfigFile()?.profiles.default?.accessToken).toBe("test-token");
  });

  it("protects both the migrated config and the retained legacy credential file", () => {
    mkdirSync(configDir, { recursive: true, mode: 0o755 });
    const oldConfigFile = path.join(configDir, "default.json");
    const oldConfig = JSON.stringify({ default: { accessToken: "legacy-test-token" } });
    writeFileSync(oldConfigFile, oldConfig, { mode: 0o644 });

    expect(readAuthConfigFile()?.profiles.default?.accessToken).toBe("legacy-test-token");

    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect(statSync(oldConfigFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(oldConfigFile, "utf8")).toBe(oldConfig);
  });

  it("does not expose rewritten credentials through an already-open file descriptor", () => {
    writeAuthConfigProfile({ accessToken: "original-test-token" });
    chmodSync(configDir, 0o755);
    chmodSync(configFile, 0o644);
    const descriptor = openSync(configFile, "r");
    try {
      writeAuthConfigProfile({ accessToken: "updated-test-token" });

      expect(JSON.parse(readFileSync(descriptor, "utf8")).profiles.default.accessToken).toBe(
        "original-test-token"
      );
      expect(readAuthConfigFile()?.profiles.default?.accessToken).toBe("updated-test-token");
      expect(statSync(configFile).mode & 0o777).toBe(0o600);
      expect(readdirSync(configDir)).toEqual(["config.json"]);
    } finally {
      closeSync(descriptor);
    }
  });

  it.skipIf(process.platform !== "linux")(
    "allows current config updates when legacy permissions cannot be changed",
    () => {
      writeAuthConfigProfile({ accessToken: "test-token" });
      const oldConfigFile = path.join(configDir, "default.json");
      symlinkSync("/proc/version", oldConfigFile);
      expect(() => chmodSync(oldConfigFile, 0o600)).toThrow();

      writeAuthConfigProfile({ accessToken: "updated-test-token" });

      expect(readAuthConfigFile()?.profiles.default?.accessToken).toBe("updated-test-token");
      expect(statSync(configFile).mode & 0o777).toBe(0o600);
    }
  );
});
