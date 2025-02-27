# Python Extension for Trigger.dev

The Python extension enhances Trigger.dev's build process by enabling limited support for executing Python scripts within your tasks.

## Overview

This extension introduces the <code>pythonExtension</code> build extension, which offers several key capabilities:

- **Install Python Dependencies (Except in Dev):** Automatically installs Python and specified dependencies using <code>pip</code>.
- **Requirements File Support:** You can specify dependencies in a <code>requirements.txt</code> file.
- **Inline Requirements:** Define dependencies directly within your <code>trigger.config.ts</code> file using the <code>requirements</code> option.
- **Virtual Environment:** Creates a virtual environment (<code>/opt/venv</code>) inside containers to isolate Python dependencies.
- **Helper Functions:** Provides a variety of functions for executing Python code:
  - <code>run</code>: Executes Python commands with proper environment setup.
  - <code>runInline</code>: Executes inline Python code directly from Node.
  - <code>runScript</code>: Executes standalone <code>.py</code> script files.
- **Custom Python Path:** In development, you can configure <code>devPythonBinaryPath</code> to point to a custom Python installation.

## Usage

1. Add the extension to your <code>trigger.config.ts</code> file:

```typescript
import { defineConfig } from "@trigger.dev/sdk/v3";
import { pythonExtension } from "@trigger.dev/python/extension";

export default defineConfig({
  project: "<project ref>",
  build: {
    extensions: [
      pythonExtension({
        requirementsFile: "./requirements.txt", // Optional: Path to your requirements file
        devPythonBinaryPath: ".venv/bin/python", // Optional: Custom Python binary path
        scripts: ["src/python/**/*.py"], // Glob pattern for Python scripts
      }),
    ],
  },
});
```

2. (Optional) Create a <code>requirements.txt</code> file in your project root with the necessary Python dependencies.

```plaintext title="requirements.txt"
pandas==1.3.3
numpy==1.21.2
```

```typescript title="trigger.config.ts"
import { defineConfig } from "@trigger.dev/sdk/v3";
import { pythonExtension } from "@trigger.dev/python/extension";

export default defineConfig({
  project: "<project ref>",
  build: {
    extensions: [
      pythonExtension({
        requirementsFile: "./requirements.txt",
      }),
    ],
  },
});
```

3. Execute Python scripts within your tasks using one of the provided functions:

### Running a Python Script

```typescript
import { task } from "@trigger.dev/sdk/v3";
import { python } from "@trigger.dev/python";

export const myScript = task({
  id: "my-python-script",
  run: async () => {
    const result = await python.runScript("my_script.py", ["hello", "world"]);
    return result.stdout;
  },
});

export const myStreamingScript = task({
  id: "my-streaming-python-script",
  run: async () => {
    // You can also stream the output of the script
    const result = python.stream.runScript("my_script.py", ["hello", "world"]);

    // result is an async iterable/readable stream
    for await (const chunk of streamingResult) {
      logger.debug("convert-url-to-markdown", {
        url: payload.url,
        chunk,
      });
    }
  },
});
```

### Running Inline Python Code

```typescript
import { task } from "@trigger.dev/sdk/v3";
import { python } from "@trigger.dev/python";

export const myTask = task({
  id: "to_datetime-task",
  run: async () => {
    const result = await python.runInline(`
import pandas as pd

pd.to_datetime("${+new Date() / 1000}")
`);
    return result.stdout;
  },
});
```

### Running Lower-Level Commands

```typescript
import { task } from "@trigger.dev/sdk/v3";
import { python } from "@trigger.dev/python";

export const pythonVersionTask = task({
  id: "python-version-task",
  run: async () => {
    const result = await python.run(["--version"]);
    return result.stdout; // Expected output: Python 3.12.8
  },
});
```

## Limitations

- This is a **partial implementation** and does not provide full Python support as an execution runtime for tasks.
- Manual intervention may be required for installing and configuring binary dependencies in development environments.

## Additional Information

For more detailed documentation, visit the official docs at [Trigger.dev Documentation](https://trigger.dev/docs).
