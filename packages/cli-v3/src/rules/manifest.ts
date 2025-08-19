import { readFile } from "fs/promises";
import { dirname, join } from "path";
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
        const { path, installStrategy, ...rest } = option;

        const $installStrategy = RulesFileInstallStrategy.safeParse(installStrategy ?? "default");

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

export class GithubRulesManifestLoader implements RulesManifestLoader {
  constructor(private readonly branch: string = "main") {}

  async loadManifestContent(): Promise<string> {
    const response = await fetch(
      `https://raw.githubusercontent.com/triggerdotdev/trigger.dev/refs/heads/${this.branch}/rules/manifest.json`
    );

    if (!response.ok) {
      throw new Error(`Failed to load rules manifest: ${response.status} ${response.statusText}`);
    }

    return response.text();
  }

  async loadRulesFile(relativePath: string): Promise<string> {
    const response = await fetch(
      `https://raw.githubusercontent.com/triggerdotdev/trigger.dev/refs/heads/${this.branch}/${relativePath}`
    );

    if (!response.ok) {
      throw new Error(
        `Failed to load rules file: ${relativePath} - ${response.status} ${response.statusText}`
      );
    }

    return response.text();
  }
}

export class LocalRulesManifestLoader implements RulesManifestLoader {
  constructor(private readonly path: string) {}

  async loadManifestContent(): Promise<string> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      throw new Error(`Failed to load rules manifest: ${this.path} - ${error}`);
    }
  }

  async loadRulesFile(relativePath: string): Promise<string> {
    const path = join(dirname(this.path), relativePath);

    try {
      return await readFile(path, "utf8");
    } catch (error) {
      throw new Error(`Failed to load rules file: ${relativePath} - ${error}`);
    }
  }
}
