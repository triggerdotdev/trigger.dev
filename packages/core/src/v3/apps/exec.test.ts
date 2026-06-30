import { describe, expect, it } from "vitest";
import { redactArgsForLogging } from "./exec.js";

describe("redactArgsForLogging", () => {
  it("masks the value following a credential flag", () => {
    expect(
      redactArgsForLogging(["login", "--username", "robot", "--password", "s3cr3t", "host:80"])
    ).toEqual(["login", "--username", "robot", "--password", "[redacted]", "host:80"]);
  });

  it("masks inline --flag=value form", () => {
    expect(redactArgsForLogging(["--token=abc123"])).toEqual(["--token=[redacted]"]);
  });

  it("leaves non-credential args untouched", () => {
    expect(redactArgsForLogging(["push", "--tls-verify=false", "host:80/img"])).toEqual([
      "push",
      "--tls-verify=false",
      "host:80/img",
    ]);
  });

  it("passes undefined through", () => {
    expect(redactArgsForLogging(undefined)).toBeUndefined();
  });
});
