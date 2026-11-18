import { describe, expect, it } from "vitest";
import { forkEnvFromRunEnv } from "./taskRunProcessProvider.js";

describe("forkEnvFromRunEnv", () => {
  // Catches: the run's secret key, run token or user env vars reaching the task process's fork env.
  it("keeps only the non-secret keys the task process needs before its first IPC message", () => {
    const runEnv = {
      TRIGGER_SECRET_KEY: "secret",
      TRIGGER_RUN_TOKEN: "token",
      TRIGGER_API_URL: "https://api.example.com",
      USER_DEFINED: "value",
      TRIGGER_PROJECT_REF: "proj_abc",
      TRIGGER_LOG_LEVEL: "debug",
      TRIGGER_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: "2048",
      NODE_EXTRA_CA_CERTS: "/certs/ca.pem",
      UV_THREADPOOL_SIZE: "16",
      LD_LIBRARY_PATH: "/app/lib",
    };

    expect(forkEnvFromRunEnv(runEnv)).toEqual({
      TRIGGER_PROJECT_REF: "proj_abc",
      TRIGGER_LOG_LEVEL: "debug",
      TRIGGER_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: "2048",
      NODE_EXTRA_CA_CERTS: "/certs/ca.pem",
      UV_THREADPOOL_SIZE: "16",
      LD_LIBRARY_PATH: "/app/lib",
    });
  });

  // Catches: a truthiness check dropping a key the run deliberately set to an empty string.
  it("keeps empty values", () => {
    expect(forkEnvFromRunEnv({ TRIGGER_LOG_LEVEL: "" })).toEqual({ TRIGGER_LOG_LEVEL: "" });
  });

  // Catches: Node, OpenSSL, libuv or loader settings from the run not applying because they arrive after startup.
  it("keeps the startup-only settings and every libuv variable", () => {
    const startupEnv = {
      TZ: "Europe/London",
      LD_PRELOAD: "/app/lib/libjemalloc.so",
      OPENSSL_CONF: "/app/openssl.cnf",
      OPENSSL_MODULES: "/app/ossl-modules",
      SSL_CERT_DIR: "/etc/ssl/certs",
      NODE_ICU_DATA: "/app/icu",
      UV_THREADPOOL_SIZE: "16",
      UV_USE_IO_URING: "0",
    };

    expect(forkEnvFromRunEnv({ ...startupEnv, TRIGGER_SECRET_KEY: "secret" })).toEqual(startupEnv);
  });

  // Catches: Node's startup proxy (NODE_USE_ENV_PROXY) not applying because the proxy settings arrive over IPC.
  it("keeps the proxy settings only when the run turns on Node's env proxy", () => {
    const proxyEnv = {
      HTTP_PROXY: "http://user:pass@proxy.example.com:8080",
      HTTPS_PROXY: "http://user:pass@proxy.example.com:8080",
      NO_PROXY: "localhost",
    };

    expect(forkEnvFromRunEnv(proxyEnv)).toEqual({});
    expect(forkEnvFromRunEnv({ ...proxyEnv, NODE_USE_ENV_PROXY: "0" })).toEqual({});
    expect(
      forkEnvFromRunEnv({ ...proxyEnv, NODE_USE_ENV_PROXY: "1", USER_DEFINED: "value" })
    ).toEqual({ ...proxyEnv, NODE_USE_ENV_PROXY: "1" });
  });
});
