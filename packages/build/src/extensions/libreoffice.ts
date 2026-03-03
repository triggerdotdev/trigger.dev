import { BuildManifest } from "@trigger.dev/core/v3";
import { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";

export type LibreOfficeOptions = {
  /**
   * Which LibreOffice component packages to install.
   * Defaults to ["writer", "impress"] for docx and pptx support.
   * - "writer"  → libreoffice-writer  (handles .doc/.docx)
   * - "impress" → libreoffice-impress (handles .ppt/.pptx)
   * - "calc"    → libreoffice-calc    (handles .xls/.xlsx)
   * - "draw"    → libreoffice-draw    (handles .odg)
   * - "math"    → libreoffice-math    (formula editor)
   */
  components?: Array<"writer" | "impress" | "calc" | "draw" | "math">;
  /**
   * Additional font packages to install beyond the built-in defaults.
   * Built-in defaults: fonts-liberation, fonts-dejavu-core.
   * Example: ["fonts-noto", "fonts-freefont-ttf"]
   */
  extraFonts?: string[];
};

export function libreoffice(options: LibreOfficeOptions = {}): BuildExtension {
  return new LibreOfficeExtension(options);
}

class LibreOfficeExtension implements BuildExtension {
  public readonly name = "LibreOfficeExtension";

  constructor(private readonly options: LibreOfficeOptions = {}) {}

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") {
      return;
    }

    const components = this.options.components ?? ["writer", "impress"];
    const componentPkgs = components.map((c) => `libreoffice-${c}`);

    // fonts-liberation: free equivalents of Times New Roman, Arial, Courier New –
    // essential for accurate rendering of most Office documents.
    // fonts-dejavu-core: broad Unicode coverage for international content.
    const fontPkgs = ["fonts-liberation", "fonts-dejavu-core", ...(this.options.extraFonts ?? [])];

    const allPkgs = [...componentPkgs, ...fontPkgs].join(" \\\n    ");

    context.logger.debug(`Adding ${this.name} to the build`, { components });

    context.addLayer({
      id: "libreoffice",
      image: {
        // Use --no-install-recommends to avoid pulling in X11 desktop packages.
        // LibreOffice's --headless flag handles PDF conversion without a display.
        instructions: [
          `RUN apt-get update && apt-get install -y --no-install-recommends \\\n    ${allPkgs} \\\n    && rm -rf /var/lib/apt/lists/*`,
        ],
      },
      deploy: {
        env: {
          LIBREOFFICE_PATH: "/usr/bin/libreoffice",
        },
        override: true,
      },
    });
  }
}
