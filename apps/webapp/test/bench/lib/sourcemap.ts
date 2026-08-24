/**
 * Just enough source-map support to turn a bundled `.cpuprofile` frame back
 * into a repo-relative source path.
 *
 * Deliberately dependency-free: the only thing needed is generated
 * (line, column) to original source path, and adding a resolver package to the
 * webapp for a bench-only tool is not worth the lockfile churn.
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_INDEX = new Map<string, number>([...BASE64].map((char, index) => [char, index]));

const FILE_URL_PREFIX = /^file:[/][/]/;

function decodeVlq(segment: string, state: { pos: number }): number {
  let result = 0;
  let shift = 0;
  let continuation = true;

  while (continuation) {
    const digit = BASE64_INDEX.get(segment[state.pos]!);
    if (digit === undefined) {
      throw new Error(`Invalid VLQ character at ${state.pos} in "${segment}"`);
    }
    state.pos += 1;
    continuation = (digit & 32) !== 0;
    result += (digit & 31) << shift;
    shift += 5;
  }

  const negative = (result & 1) === 1;
  result >>>= 1;
  return negative ? -result : result;
}

type Mapping = {
  generatedColumn: number;
  sourceIndex: number;
  originalLine: number;
};

type RawSourceMap = {
  sources: (string | null)[];
  sourceRoot?: string;
  mappings: string;
};

type ParsedSourceMap = { sources: string[]; lines: Mapping[][] };

export class SourceMapResolver {
  private byGeneratedFile = new Map<string, ParsedSourceMap | null>();
  private repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  private load(generatedPath: string): ParsedSourceMap | null {
    if (this.byGeneratedFile.has(generatedPath)) {
      return this.byGeneratedFile.get(generatedPath)!;
    }

    let parsed: ParsedSourceMap | null = null;

    try {
      const raw = JSON.parse(readFileSync(`${generatedPath}.map`, "utf8")) as RawSourceMap;
      const mapDir = dirname(generatedPath);
      const sourceRoot = raw.sourceRoot ?? "";

      const sources = raw.sources.map((source) => {
        if (!source) return "(unknown)";
        const absolute = resolve(mapDir, sourceRoot, source.replace(FILE_URL_PREFIX, ""));
        return relative(this.repoRoot, absolute);
      });

      parsed = { sources, lines: decodeMappings(raw.mappings) };
    } catch {
      parsed = null;
    }

    this.byGeneratedFile.set(generatedPath, parsed);
    return parsed;
  }

  /**
   * Returns the repo-relative original source and 1-based line for a generated
   * position, or undefined when there is no map or no mapping at or before
   * that column.
   */
  resolve(
    generatedPath: string,
    line: number,
    column: number
  ): { source: string; line: number } | undefined {
    const map = this.load(generatedPath);
    if (!map) return undefined;

    const mappings = map.lines[line];
    if (!mappings || mappings.length === 0) return undefined;

    let low = 0;
    let high = mappings.length - 1;
    let found: Mapping | undefined;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const candidate = mappings[mid]!;
      if (candidate.generatedColumn <= column) {
        found = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const mapping = found ?? mappings[0]!;
    const source = map.sources[mapping.sourceIndex];
    if (source === undefined) return undefined;
    return { source, line: mapping.originalLine + 1 };
  }
}

function decodeMappings(mappings: string): Mapping[][] {
  const lines: Mapping[][] = [];

  let sourceIndex = 0;
  let originalLine = 0;

  for (const lineSegments of mappings.split(";")) {
    const decoded: Mapping[] = [];
    let generatedColumn = 0;

    if (lineSegments.length > 0) {
      for (const segment of lineSegments.split(",")) {
        if (segment.length === 0) continue;

        const state = { pos: 0 };
        generatedColumn += decodeVlq(segment, state);

        if (state.pos < segment.length) {
          sourceIndex += decodeVlq(segment, state);
          originalLine += decodeVlq(segment, state);
          decodeVlq(segment, state);
          if (state.pos < segment.length) decodeVlq(segment, state);

          decoded.push({ generatedColumn, sourceIndex, originalLine });
        }
      }
    }

    decoded.sort((a, b) => a.generatedColumn - b.generatedColumn);
    lines.push(decoded);
  }

  return lines;
}
