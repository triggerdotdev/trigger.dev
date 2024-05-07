import { z } from "zod";
import { TaskRunError } from "./schemas/common";
import nodePath from "node:path";

export function parseError(error: unknown): TaskRunError {
  if (error instanceof Error) {
    return {
      type: "BUILT_IN_ERROR",
      name: error.name,
      message: error.message,
      stackTrace: error.stack ?? "",
    };
  }

  if (typeof error === "string") {
    return {
      type: "STRING_ERROR",
      raw: error,
    };
  }

  try {
    return {
      type: "CUSTOM_ERROR",
      raw: JSON.stringify(error),
    };
  } catch (e) {
    return {
      type: "CUSTOM_ERROR",
      raw: String(error),
    };
  }
}

export function createErrorTaskError(error: TaskRunError): any {
  switch (error.type) {
    case "BUILT_IN_ERROR": {
      const e = new Error(error.message);

      e.name = error.name;
      e.stack = error.stackTrace;

      return e;
    }
    case "STRING_ERROR": {
      return error.raw;
    }
    case "CUSTOM_ERROR": {
      return JSON.parse(error.raw);
    }
    case "INTERNAL_ERROR": {
      return new Error(`trigger.dev internal error (${error.code})`);
    }
  }
}

export function createJsonErrorObject(error: TaskRunError) {
  switch (error.type) {
    case "BUILT_IN_ERROR": {
      return {
        name: error.name,
        message: error.message,
        stackTrace: error.stackTrace,
      };
    }
    case "STRING_ERROR": {
      return {
        message: error.raw,
      };
    }
    case "CUSTOM_ERROR": {
      return {
        message: error.raw,
      };
    }
    case "INTERNAL_ERROR": {
      return {
        message: `trigger.dev internal error (${error.code})`,
      };
    }
  }
}

export function correctErrorStackTrace(
  stackTrace: string,
  projectDir?: string,
  options?: { removeFirstLine?: boolean }
) {
  const [errorLine, ...traceLines] = stackTrace.split("\n");

  return [
    options?.removeFirstLine ? undefined : errorLine,
    ...traceLines.map((line) => correctStackTraceLine(line, projectDir)),
  ]
    .filter(Boolean)
    .join("\n");
}

const LINES_TO_IGNORE = [
  /ConsoleInterceptor/,
  /TriggerTracer/,
  /TaskExecutor/,
  /EXECUTE_TASK_RUN/,
  /@trigger.dev\/core/,
  /safeJsonProcess/,
  /__entryPoint.ts/,
];

function correctStackTraceLine(line: string, projectDir?: string) {
  if (LINES_TO_IGNORE.some((regex) => regex.test(line))) {
    return;
  }

  // Check to see if the path is inside the project directory
  if (projectDir && !line.includes(projectDir)) {
    return;
  }

  return line.trim();
}

export function groupTaskMetadataIssuesByTask(tasks: any, issues: z.ZodIssue[]) {
  return issues.reduce(
    (acc, issue) => {
      if (issue.path.length === 0) {
        return acc;
      }

      const taskIndex = issue.path[1];

      if (typeof taskIndex !== "number") {
        return acc;
      }

      const task = tasks[taskIndex];

      if (!task) {
        return acc;
      }

      const restOfPath = issue.path.slice(2);

      const taskId = task.id;
      const taskName = task.exportName;
      const filePath = task.filePath;

      const key = taskIndex;

      const existing = acc[key] ?? {
        id: taskId,
        exportName: taskName,
        filePath,
        issues: [] as Array<{ message: string; path?: string }>,
      };

      existing.issues.push({
        message: issue.message,
        path: restOfPath.length === 0 ? undefined : restOfPath.join("."),
      });

      return {
        ...acc,
        [key]: existing,
      };
    },
    {} as Record<
      number,
      {
        id: any;
        exportName: string;
        filePath: string;
        issues: Array<{ message: string; path?: string }>;
      }
    >
  );
}
