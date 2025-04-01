import { defineConfig } from "@trigger.dev/sdk";
import { pythonExtension } from "@trigger.dev/python/extension";
import { installPlaywrightChromium } from "./src/extensions/playwright";

export default defineConfig({
  project: "proj_cdmymsrobxmcgjqzhdkq",
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  build: {
    extensions: [
      // This is required to use the Python extension
      pythonExtension({
        requirementsFile: "./requirements.txt", // Optional: Path to your requirements file
        devPythonBinaryPath: `.venv/bin/python`, // Optional: Custom Python binary path
        scripts: ["src/trigger/python/**/*.py"], // List of Python scripts to include
      }),
      installPlaywrightChromium(),
    ],
  },
});
