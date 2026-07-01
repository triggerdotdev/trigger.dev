import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { RulesFileInstallStrategy } from "./types.js";

const RulesManifestDataSchema = z.object({
  name: z.string(),
  description: z.string(),
  currentVersion: z.string(),
  versions: z.record(
    z.string(),
    z.object({
      options: z.array(
        z.object({
          name: z.string(),
          title: z.string(),
          label: z.string(),
          path: z.string(),
          tokens: z.number(),
          client: z.string().optional(),
          installStrategy: z.string().optional(),
          applyTo: z.string().optional(),
        })
      ),
    })
  ),
});

type RulesManifestData = z.infer<typeof RulesManifestDataSchema>;

export type RulesManifestVersionOption = {
  name: string;
  title: string;
  label: string;
  contents: string;
  tokens: number;
  client: string | undefined;
  installStrategy: RulesFileInstallStrategy;
  applyTo: string | undefined;
};

export type ManifestVersion = {
  version: string;
  options: Array<RulesManifestVersionOption>;
};

export class RulesManifest {
  constructor(
    private readonly manifest: RulesManifestData,
    private readonly loader: RulesManifestLoader
  ) {}

  get name() {
    return this.manifest.name;
  }

  get description() {
    return this.manifest.description;
  }

  get currentVersion() {
    return this.manifest.currentVersion;
  }

  async getCurrentVersion(): Promise<ManifestVersion> {
    const version = this.versions[this.manifest.currentVersion];

    if (!version) {
      throw new Error(`Version ${this.manifest.currentVersion} not found in manifest`);
    }

    const options = await Promise.all(
      version.options.map(async (option) => {
        const contents = await this.loader.loadRulesFile(option.path);

        // Omit path
        const { path: _path, installStrategy, ...rest } = option;

        const $installStrategy = RulesFileInstallStrategy.safeParse(installStrategy ?? "skills");

        // Skip variants with invalid install strategies
        if (!$installStrategy.success) {
          return;
        }

        return { ...rest, contents, installStrategy: $installStrategy.data };
      })
    );

    return {
      version: this.manifest.currentVersion,
      options: options.filter(Boolean) as Array<ManifestVersion["options"][number]>,
    };
  }

  get versions() {
    return this.manifest.versions;
  }
}

export async function loadRulesManifest(loader: RulesManifestLoader): Promise<RulesManifest> {
  const content = await loader.loadManifestContent();

  return new RulesManifest(RulesManifestDataSchema.parse(JSON.parse(content)), loader);
}

export interface RulesManifestLoader {
  loadManifestContent(): Promise<string>;
  loadRulesFile(relativePath: string): Promise<string>;
}

/**
 * Loads agent skills bundled inside the `trigger.dev` CLI (the `skills/` folder shipped
 * via the package's `files[]`). The CLI is the only source of skills; `skillsDir` and
 * `version` are resolved from the CLI's own package by the caller and injected here, so
 * this stays a pure reader. Synthesizes the manifest shape the install pipeline consumes
 * so skills flow through `loadRulesManifest` -> `getCurrentVersion` -> install, with
 * `installStrategy: "skills"`. `version` (== the CLI/SDK version) is stamped into each
 * skill on read in place of the `{{TRIGGER_SDK_VERSION}}` placeholder.
 */
export class BundledSkillsLoader implements RulesManifestLoader {
  constructor(
    private readonly skillsDir: string,
    private readonly version: string
  ) {}

  async loadManifestContent(): Promise<string> {
    let entries: string[] = [];
    try {
      const dirents = await readdir(this.skillsDir, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort();
    } catch (error) {
      throw new Error(`No skills found in ${this.skillsDir}: ${error}`);
    }

    const options = [];
    for (const name of entries) {
      const skillMdPath = join(this.skillsDir, name, "SKILL.md");

      let contents: string;
      try {
        contents = await readFile(skillMdPath, "utf8");
      } catch {
        // a directory without a SKILL.md isn't a skill
        continue;
      }

      const description = extractSkillDescription(contents) ?? humanizeSkillName(name);

      options.push({
        name,
        title: humanizeSkillName(name),
        label: description,
        path: join(name, "SKILL.md"),
        tokens: Math.max(1, Math.round(contents.length / 4)),
        installStrategy: "skills",
      });
    }

    if (options.length === 0) {
      throw new Error(`No skills with a SKILL.md found in ${this.skillsDir}`);
    }

    return JSON.stringify({
      name: "trigger.dev",
      description: "Trigger.dev agent skills",
      currentVersion: this.version,
      versions: {
        [this.version]: { options },
      },
    });
  }

  async loadRulesFile(relativePath: string): Promise<string> {
    const path = join(this.skillsDir, relativePath);

    try {
      const raw = await readFile(path, "utf8");
      // Stamp the CLI/SDK version into the skill so the copy on disk reflects the
      // version the user is on, not a hardcoded number that drifts.
      return raw.replace(/\{\{TRIGGER_SDK_VERSION\}\}/g, this.version);
    } catch (error) {
      throw new Error(`Failed to load skill file: ${relativePath} - ${error}`);
    }
  }
}

function humanizeSkillName(name: string): string {
  const spaced = name.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Best-effort extraction of the `description` field from a SKILL.md YAML frontmatter
 * block, used only for the picker label. Handles single-line, quoted, and folded/literal
 * (`>`, `|`) scalars. Returns undefined if there's no frontmatter or description.
 */
function extractSkillDescription(skillMd: string): string | undefined {
  const match = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = match?.[1];
  if (!frontmatter) {
    return undefined;
  }

  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }

    const m = line.match(/^description:\s*(.*)$/);
    if (!m) {
      continue;
    }

    const value = (m[1] ?? "").trim();

    // Folded (>) or literal (|) block scalar: collect the indented continuation lines.
    if (/^[>|][+-]?$/.test(value)) {
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next === undefined) {
          break;
        }
        if (/^\s+\S/.test(next)) {
          collected.push(next.trim());
        } else if (next.trim() === "") {
          collected.push("");
        } else {
          break;
        }
      }
      return collected.join(" ").replace(/\s+/g, " ").trim() || undefined;
    }

    // Inline scalar, possibly quoted.
    return value.replace(/^["']|["']$/g, "").trim() || undefined;
  }

  return undefined;
}
