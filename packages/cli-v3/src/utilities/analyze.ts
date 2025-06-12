import type { WorkerManifest } from "@trigger.dev/core/v3";
import { chalkGreen, chalkError, chalkWarning, chalkTask, chalkPurple } from "./cliOutput.js";
import chalk from "chalk";
import type { Metafile } from "esbuild";
import CLITable from "cli-table3";
import { BackgroundWorker } from "../dev/backgroundWorker.js";

export function analyzeWorker(
  worker: BackgroundWorker,
  printDetails = false,
  disableWarnings = false
) {
  if (!worker.manifest) {
    return;
  }

  if (printDetails) {
    printBundleTree(worker.manifest, worker.metafile);
    printBundleSummaryTable(worker.manifest, worker.metafile);
  }

  if (!disableWarnings) {
    printWarnings(worker.manifest);
  }
}

export function printBundleTree(
  workerManifest: WorkerManifest,
  metafile: Metafile,
  opts?: {
    sortBy?: "timing" | "bundleSize";
    preservePath?: boolean;
    collapseBundles?: boolean;
  }
) {
  const sortBy = opts?.sortBy ?? "timing";
  const preservePath = opts?.preservePath ?? true;
  const collapseBundles = opts?.collapseBundles ?? false;

  const data = getBundleTreeData(workerManifest, metafile);

  if (sortBy === "timing") {
    data.sort((a, b) => (a.timing ?? Infinity) - (b.timing ?? Infinity));
  } else if (sortBy === "bundleSize") {
    data.sort((a, b) => b.bundleSize - a.bundleSize);
  }

  const { outputs } = metafile;

  // Build the output-defines-task-ids map once
  const outputDefinesTaskIds = buildOutputDefinesTaskIdsMap(workerManifest, metafile);

  for (const item of data) {
    const { filePath, taskIds, bundleSize, bundleChildren, timing } = item;

    // Print the root
    const displayPath = getDisplayPath(filePath, preservePath);
    const timingStr = formatTimingColored(timing, true);
    console.log(chalk.bold(chalkPurple(displayPath)) + " " + timingStr);

    // Determine if we have both tasks and bundles to print as siblings
    const taskCount = taskIds.length;
    const hasBundles = bundleChildren.length > 0;
    const hasTasks = taskCount > 0;
    const showTasks = hasTasks;
    const showBundles = hasBundles;

    if (showTasks) {
      const symbol = showBundles ? "├──" : "└──";
      console.log(`  ${symbol} ${chalk.bold(formatTaskCountLabel(taskCount))}`);

      const indent = showBundles ? "  │   " : "      ";
      printTaskTree(taskIds, indent);
    }

    if (showBundles) {
      // Find the output file for this task file
      const outputFile = findOutputFileByEntryPoint(outputs, filePath);

      // Calculate total bundle size and unique bundle count
      const totalBundleSize = outputFile ? sumBundleTreeUnique(outputs, outputFile) : 0;
      const bundleSizeColored = formatSizeColored(totalBundleSize, true);
      const uniqueBundleCount = outputFile ? countUniqueBundles(outputs, outputFile) : 0;
      const bundleLabel = formatBundleLabel(uniqueBundleCount, bundleSizeColored);

      console.log(`  └── ${chalk.bold(bundleLabel)}`);

      if (!collapseBundles) {
        // Print the root bundle as the only child under bundles
        const taskSeen = new Set<string>();
        printBundleRoot({
          outputs,
          outputFile,
          preservePath,
          indent: "      ",
          taskSeen,
          outputDefinesTaskIds,
        });
      }
    }

    console.log("");
  }
}

export function printBundleSummaryTable(
  workerManifest: WorkerManifest,
  metafile: Metafile,
  opts?: { preservePath?: boolean }
) {
  const data = getBundleTreeData(workerManifest, metafile);
  // Sort by timing (asc, missing last), then bundle size (desc), then file (asc)
  const sorted = [...data].sort(sortBundleTableData);

  const preservePath = opts?.preservePath ?? true;

  const table = new CLITable({
    head: [
      chalk.bold("File"),
      chalk.bold("Tasks"),
      chalk.bold("Bundle size"),
      chalk.bold("Import timing"),
    ],
    style: {
      head: ["blue"],
      border: ["gray"],
    },
    wordWrap: true,
  });

  for (const item of sorted) {
    const { filePath, taskIds, bundleSize, timing } = item;
    const displayPath = getDisplayPath(filePath, preservePath);
    const bundleSizeColored = formatSizeColored(bundleSize, false);
    const timingStr = formatTimingColored(timing, false);
    table.push([displayPath, taskIds.length, bundleSizeColored, timingStr]);
  }

  console.log(table.toString());
}

export function printWarnings(workerManifest: WorkerManifest) {
  if (!workerManifest.timings) {
    return;
  }

  const timings = workerManifest.timings;
  const tasksByFile = getTasksByFile(workerManifest.tasks);

  let hasWarnings = false;

  for (const [filePath, timing] of Object.entries(timings)) {
    // Warn if the file takes more than 1 second to import
    if (timing > 1000) {
      if (!hasWarnings) {
        console.log("");
        hasWarnings = true;
      }

      const taskIds = tasksByFile[filePath] || [];
      const timingStr = chalkError(`(${Math.round(timing)}ms)`);

      // File path: bold and purple
      console.log(`${chalk.bold(chalkPurple(filePath))} ${timingStr}`);

      // Tasks: blue with a nice tree symbol
      taskIds.forEach((id: string, idx: number) => {
        const isLast = idx === taskIds.length - 1;
        const symbol = isLast ? "└──" : "├──";
        console.log(`${chalkTask(symbol)} ${chalkTask(id)}`);
      });
      console.log("");
      console.log(
        chalkError(
          "Warning: Slow import timing detected (>1s). This will cause slow startups. Consider optimizing this file."
        )
      );
      console.log("");
    }
  }

  if (hasWarnings) {
    printSlowImportTips();
  }
}

function getTasksByFile(tasks: WorkerManifest["tasks"]): Record<string, string[]> {
  const tasksByFile: Record<string, string[]> = {};
  tasks.forEach((task) => {
    const filePath = task.filePath;
    if (!tasksByFile[filePath]) {
      tasksByFile[filePath] = [];
    }
    tasksByFile[filePath].push(task.id);
  });
  return tasksByFile;
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) {
    return chalkError(`${(bytes / (1024 * 1024)).toFixed(2)} MB`);
  } else if (bytes > 1024) {
    return chalkWarning(`${(bytes / 1024).toFixed(1)} KB`);
  } else {
    return chalkGreen(`${bytes} B`);
  }
}

function normalizePath(path: string): string {
  // Remove .trigger/tmp/build-<hash>/ prefix
  return path.replace(/(^|\/).trigger\/tmp\/build-[^/]+\//, "");
}

interface BundleTreeData {
  filePath: string;
  taskIds: string[];
  bundleSize: number;
  bundleCount: number;
  timing?: number;
  bundleChildren: string[];
}

function getBundleTreeData(workerManifest: WorkerManifest, metafile: Metafile): BundleTreeData[] {
  const tasksByFile = getTasksByFile(workerManifest.tasks);
  const outputs = metafile.outputs;
  const timings = workerManifest.timings || {};

  // Map entryPoint (source file) to output file in outputs
  const entryToOutput: Record<string, string> = {};
  for (const [outputPath, outputMeta] of Object.entries(outputs)) {
    if (outputMeta.entryPoint) {
      entryToOutput[outputMeta.entryPoint] = outputPath;
    }
  }

  const result: BundleTreeData[] = [];

  for (const filePath of Object.keys(tasksByFile)) {
    const outputFile = entryToOutput[filePath];
    const taskIds = tasksByFile[filePath];
    if (!taskIds || taskIds.length === 0) continue;
    let bundleTreeInfo = { total: 0, count: 0 };
    let bundleChildren: string[] = [];
    if (outputFile && outputs[outputFile]) {
      bundleChildren = getInternalChildren(outputs[outputFile], outputs);
      // Sum up all bundles in the tree (excluding the root)
      const seen = new Set<string>();
      bundleChildren.forEach((child: string, idx: number) => {
        const res = sumBundleTree(outputs, child, seen);
        bundleTreeInfo.total += res.total;
        bundleTreeInfo.count += res.count;
      });
    }
    result.push({
      filePath,
      taskIds,
      bundleSize: bundleTreeInfo.total,
      bundleCount: bundleTreeInfo.count,
      timing: typeof timings[filePath] === "number" ? timings[filePath] : undefined,
      bundleChildren,
    });
  }
  return result;
}

function sumBundleTree(
  outputs: Metafile["outputs"],
  current: string,
  seen: Set<string>
): { total: number; count: number } {
  if (seen.has(current)) {
    return { total: 0, count: 0 };
  }

  seen.add(current);
  const output = outputs[current];

  if (!output) {
    return { total: 0, count: 0 };
  }

  const size = output.bytes;
  const children = getInternalChildren(output, outputs);
  let total = size;
  let count = 1;
  children.forEach((child: string) => {
    const res = sumBundleTree(outputs, child, seen);
    total += res.total;
    count += res.count;
  });

  return { total, count };
}

// Helper to format bundle size with color
function formatSizeColored(bytes: number, withBraces = false): string {
  let str: string;
  if (bytes > 5 * 1024 * 1024) {
    str = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    str = withBraces ? chalkError(`(${str})`) : chalkError(str);
  } else if (bytes > 1024 * 1024) {
    str = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    str = withBraces ? chalkWarning(`(${str})`) : chalkWarning(str);
  } else if (bytes > 1024) {
    str = `${(bytes / 1024).toFixed(1)} KB`;
    str = withBraces ? chalkGreen(`(${str})`) : chalkGreen(str);
  } else {
    str = `${bytes} B`;
    str = withBraces ? chalkGreen(`(${str})`) : chalkGreen(str);
  }
  return str;
}

// Helper to format timing with color
function formatTimingColored(timing?: number, withBraces = false): string {
  let str: string;
  if (typeof timing !== "number") {
    str = "?ms";
    return withBraces ? chalkGreen(`(${str})`) : chalkGreen(str);
  }
  if (timing > 1000) {
    str = `${Math.round(timing)}ms`;
    return withBraces ? chalkError(`(${str})`) : chalkError(str);
  } else if (timing > 200) {
    str = `${Math.round(timing)}ms`;
    return withBraces ? chalkWarning(`(${str})`) : chalkWarning(str);
  } else {
    str = `${Math.round(timing)}ms`;
    return withBraces ? chalkGreen(`(${str})`) : chalkGreen(str);
  }
}

interface PrintBundleTreeNodeOptions {
  outputs: Metafile["outputs"];
  current: string;
  branchSeen: Set<string>;
  taskSeen: Set<string>;
  prefix?: string;
  isLast?: boolean;
  preservePath?: boolean;
  colorBundleSize?: boolean;
}

// Helper to build a map from output file path to task IDs it actually defines (based on inputs)
function buildOutputDefinesTaskIdsMap(
  workerManifest: WorkerManifest,
  metafile: Metafile
): Record<string, Set<string>> {
  const outputs = metafile.outputs;

  // Map from task file path to task IDs
  const filePathToTaskIds: Record<string, string[]> = {};
  for (const task of workerManifest.tasks) {
    if (!filePathToTaskIds[task.filePath]) filePathToTaskIds[task.filePath] = [];
    filePathToTaskIds[task.filePath]!.push(task.id);
  }

  // Map from output file to set of task IDs it defines
  const outputDefinesTaskIds: Record<string, Set<string>> = {};
  for (const [outputPath, outputMeta] of Object.entries(outputs)) {
    if (!outputMeta.inputs) continue;
    for (const inputPath of Object.keys(outputMeta.inputs)) {
      if (filePathToTaskIds[inputPath]) {
        if (!outputDefinesTaskIds[outputPath]) outputDefinesTaskIds[outputPath] = new Set();
        for (const taskId of filePathToTaskIds[inputPath]) {
          outputDefinesTaskIds[outputPath].add(taskId);
        }
      }
    }
  }

  return outputDefinesTaskIds;
}

function getDefinesTaskLabel(
  taskIds: Set<string> | undefined,
  prefix = "<-- defines tasks: "
): string {
  if (!taskIds) {
    return "";
  }

  if (taskIds.size === 0) {
    return "";
  }

  return " " + chalk.cyanBright(`${prefix}${Array.from(taskIds).join(", ")}`);
}

function printBundleTreeNode({
  outputs,
  current,
  branchSeen,
  taskSeen,
  prefix = "",
  isLast = true,
  preservePath = true,
  colorBundleSize = false,
  outputDefinesTaskIds = {},
}: PrintBundleTreeNodeOptions & { outputDefinesTaskIds?: Record<string, Set<string>> }) {
  // Detect circular dependencies
  if (branchSeen.has(current)) {
    const displayPath = preservePath ? current : normalizePath(current);
    console.log(
      prefix + (isLast ? "└── " : "├── ") + chalk.grey(displayPath) + chalk.grey(" (circular)")
    );
    return;
  }

  // Detect already seen bundles (per task)
  if (taskSeen.has(current)) {
    const displayPath = preservePath ? current : normalizePath(current);
    console.log(prefix + (isLast ? "└── " : "├── ") + chalk.grey(displayPath));
    return;
  }

  // Add to seen cache
  branchSeen.add(current);
  taskSeen.add(current);

  // Get the output for the current node
  const output = outputs[current];
  if (!output) {
    const displayPath = preservePath ? current : normalizePath(current);
    console.log(
      prefix +
        (isLast ? "└── " : "├── ") +
        chalk.grey(displayPath) +
        chalk.grey(" (not found in outputs)")
    );
    return;
  }

  // Get the size and children of the current node
  const size = output.bytes;
  const children = getInternalChildren(output, outputs);

  const newPrefix = prefix + (isLast ? "    " : "│   ");
  const displayPath = preservePath ? current : normalizePath(current);
  const sizeStr = colorBundleSize ? formatSizeColored(size, true) : formatSize(size);
  const definesTaskLabel =
    output && !output.entryPoint ? getDefinesTaskLabel(outputDefinesTaskIds[current]) : "";
  console.log(
    prefix + (isLast ? "└── " : "├── ") + chalk.bold(displayPath) + ` ` + sizeStr + definesTaskLabel
  );

  // Print the children
  children.forEach((child: string, idx: number) => {
    printBundleTreeNode({
      outputs,
      current: child,
      branchSeen: new Set(branchSeen),
      taskSeen,
      prefix: newPrefix,
      isLast: idx === children.length - 1,
      preservePath,
      colorBundleSize,
      outputDefinesTaskIds,
    });
  });
}

// Helper to sum the size of the root bundle and all unique descendants
function sumBundleTreeUnique(outputs: Metafile["outputs"], root: string): number {
  const seen = new Set<string>();
  function walk(current: string) {
    if (seen.has(current)) return 0;
    seen.add(current);
    const output = outputs[current];
    if (!output) return 0;
    let total = output.bytes;
    const children = getInternalChildren(output, outputs);
    for (const child of children) {
      total += walk(child);
    }
    return total;
  }
  return walk(root);
}

// Helper to count unique bundles in the tree
function countUniqueBundles(outputs: Metafile["outputs"], root: string): number {
  const seen = new Set<string>();
  function walk(current: string) {
    if (seen.has(current)) return;
    seen.add(current);
    const output = outputs[current];
    if (!output) return;
    const children = getInternalChildren(output, outputs);
    for (const child of children) {
      walk(child);
    }
  }
  walk(root);
  return seen.size;
}

function printBundleRoot({
  outputs,
  outputFile,
  preservePath,
  indent = "      ",
  taskSeen,
  outputDefinesTaskIds,
}: {
  outputs: Metafile["outputs"];
  outputFile: string | undefined;
  preservePath: boolean;
  indent?: string;
  taskSeen: Set<string>;
  outputDefinesTaskIds: Record<string, Set<string>>;
}) {
  if (!outputFile) {
    return;
  }

  const output = outputs[outputFile];

  if (!output) {
    return;
  }

  const rootBundleDisplayPath = getDisplayPath(outputFile, preservePath);
  const rootBundleSizeColored = formatSizeColored(output.bytes, true);

  const definesTaskLabel = !output.entryPoint
    ? getDefinesTaskLabel(outputDefinesTaskIds[outputFile])
    : "";

  // Print root bundle node (always └──)
  console.log(
    `${indent}└── ${chalk.bold(rootBundleDisplayPath)} ${rootBundleSizeColored}${definesTaskLabel}`
  );

  // Print children as children of the root bundle node
  const children = getInternalChildren(output, outputs);

  children.forEach((child: string, idx: number) => {
    printBundleTreeNode({
      outputs,
      current: child,
      branchSeen: new Set<string>([outputFile]),
      taskSeen,
      prefix: indent + "    ",
      isLast: idx === children.length - 1,
      preservePath,
      colorBundleSize: true,
      outputDefinesTaskIds,
    });
  });
}

function getInternalChildren(
  output: Metafile["outputs"][string],
  outputs: Metafile["outputs"]
): string[] {
  return (output.imports || [])
    .filter((imp) => !imp.external && outputs[imp.path])
    .map((imp) => imp.path);
}

function findOutputFileByEntryPoint(
  outputs: Metafile["outputs"],
  entryPoint: string
): string | undefined {
  for (const [outputPath, outputMeta] of Object.entries(outputs)) {
    if (outputMeta.entryPoint === entryPoint) {
      return outputPath;
    }
  }
  return undefined;
}

function formatTaskCountLabel(count: number): string {
  return `${count} task${count === 1 ? "" : "s"}`;
}

function formatBundleLabel(count: number, size: string): string {
  return `${count} bundle${count === 1 ? "" : "s"} ${size}`;
}

function getDisplayPath(path: string, preserve: boolean): string {
  return preserve ? path : normalizePath(path);
}

function sortBundleTableData(a: BundleTreeData, b: BundleTreeData): number {
  const aTiming = typeof a.timing === "number" ? a.timing : -Infinity;
  const bTiming = typeof b.timing === "number" ? b.timing : -Infinity;
  if (aTiming !== bTiming) return bTiming - aTiming;
  if (b.bundleSize !== a.bundleSize) return b.bundleSize - a.bundleSize;
  return a.filePath.localeCompare(b.filePath);
}

function printTaskTree(taskIds: string[], indent = "", colorFn = chalkTask) {
  taskIds.forEach((id: string, idx: number) => {
    const isLast = idx === taskIds.length - 1;
    const symbol = isLast ? "└──" : "├──";
    console.log(`${indent}${symbol} ${colorFn(id)}`);
  });
}

function printSlowImportTips() {
  console.log("Some tips for improving slow imports:");
  console.log(
    "- Are there a lot of tasks in this file? Consider splitting it into multiple files with a single task per file."
  );
  console.log(
    "- Are you importing any tasks? Consider importing only the task types and trigger with `tasks.trigger(<task-id>)` instead. See: https://trigger.dev/docs/triggering#tasks-trigger"
  );
  console.log(
    "- Are there expensive operations outside of your task at the top level of the file? Consider moving them inside the task or only running them on demand by moving them into a function."
  );
  console.log(
    "- Are you importing large libraries or modules that aren't used in all code paths? Consider importing them only when needed, for example with a dynamic `await import()`."
  );
  console.log(
    "- Are you using third-party packages that are known to be slow to import? Check if there are lighter alternatives or if you can import only specific submodules."
  );

  console.log("");

  console.log("To see more details, run with the --analyze flag.");
  console.log("To disable these warnings, run with the --disable-warnings flag.");

  console.log("");
}
