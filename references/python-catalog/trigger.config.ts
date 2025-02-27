import { defineConfig } from "@trigger.dev/sdk/v3";
import { pythonExtension } from "@trigger.dev/python/extension";

export default defineConfig({
  runtime: "node",
  project: "proj_hbsqkjxevkyuklehrgrp",
  machine: "small-1x",
  maxDuration: 3600,
  dirs: ["./src/trigger"],
  build: {
    extensions: [
      pythonExtension({
        requirementsFile: "./requirements.txt", // Optional: Path to your requirements file
        devPythonBinaryPath: `.venv/bin/python`, // Optional: Custom Python binary path
        scripts: ["src/python/**/*.py"], // List of Python scripts to include
      }),
    ],
  },
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 5_000,
      factor: 1.6,
      randomize: true,
    },
  },
});
