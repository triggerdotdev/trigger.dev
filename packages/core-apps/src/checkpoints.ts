import { randomUUID } from "crypto";
import { $, type ExecaChildProcess } from "execa";

export function isExecaChildProcess(maybeExeca: unknown): maybeExeca is Awaited<ExecaChildProcess> {
  return typeof maybeExeca === "object" && maybeExeca !== null && "escapedCommand" in maybeExeca;
}

export type CheckpointTestResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      message: string;
      error?: unknown;
    };

export async function testDockerCheckpoint(): Promise<CheckpointTestResult> {
  try {
    // Create a dummy container
    const container =
      await $`docker run -d --rm --name init-dummy-${randomUUID()} docker.io/library/busybox sleep 10`;

    // Checkpoint it
    await $`docker checkpoint create ${container} init-check`;
  } catch (error) {
    if (!isExecaChildProcess(error)) {
      return {
        ok: false,
        message: "No checkpoint support: Unknown error.",
        error,
      };
    }

    if (error.stderr.includes("criu")) {
      if (error.stderr.includes("executable file not found")) {
        return {
          ok: false,
          message: "No checkpoint support: Missing CRIU binary.",
        };
      }

      return {
        ok: false,
        message: "No checkpoint support: Unknown CRIU error.",
        error,
      };
    }

    if (error.stderr.includes("experimental features enabled")) {
      return {
        ok: false,
        message: "No checkpoint support: Please enable docker experimental features.",
      };
    }

    return {
      ok: false,
      message: "No checkpoint support: Unknown execa error.",
      error,
    };
  }

  return {
    ok: true,
  };
}
