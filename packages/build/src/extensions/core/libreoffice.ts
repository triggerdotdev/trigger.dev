import { BuildExtension } from "@trigger.dev/core/v3/build";
import { dirname } from "node:path";
import { readPackageJSON } from "pkg-types";

export type LibreOfficeOptions = {
  /**
   * Use the minimal LibreOffice writer package (libreoffice-writer) instead of full LibreOffice.
   * Sufficient for docx/pptx/xlsx to PDF conversion. Saves ~400MB vs. full install.
   * @default false
   */
  minimal?: boolean;
};

/**
 * Build extension that installs LibreOffice for docx/pptx/xlsx → PDF conversion.
 *
 * Adds the `libreoffice-convert` npm package and the required system packages
 * to the Docker build image. The extension is scoped to "deploy" target only
 * (dev uses the host machine's LibreOffice if available).
 *
 * @example
 * ```ts
 * // In trigger.config.ts
 * import { libreoffice } from "@trigger.dev/build/extensions/core";
 *
 * build: {
 *   extensions: [
 *     libreoffice(),
 *   ]
 * }
 * ```
 *
 * Then in your task:
 * ```ts
 * import libreofficeConvert from "libreoffice-convert";
 * // Convert docx → PDF
 * const pdfBuffer = await libreofficeConvert(docxBuffer, "pdf");
 * ```
 */
export function libreoffice(options: LibreOfficeOptions = {}): BuildExtension {
  const { minimal = false } = options;

  // The npm package used for conversion
  const NPM_PACKAGE = "libreoffice-convert";

  return {
    name: "libreoffice",

    async onBuildStart(context) {
      if (context.target !== "deploy") {
        return;
      }

      // ── System packages (apt) ─────────────────────────────────────────────
      // `aptGet` is defined in the same core directory.
      // We delegate to it by registering an apt-get layer.
      const systemPackages = minimal
        ? [
            "libreoffice-writer",
            "libreoffice-calc",
            "libreoffice-impress",
            "fonts-liberation",
            "--no-install-recommends",
          ]
        : [
            "libreoffice",
            "--no-install-recommends",
          ];

      context.addLayer({
        id: "libreoffice-apt",
        image: {
          pkgs: systemPackages,
        },
      });

      // ── npm package ────────────────────────────────────────────────────────
      // Resolve the locally installed version of libreoffice-convert if present,
      // otherwise fall back to "latest".
      let version = "latest";
      try {
        const modulePath = await context.resolvePath(NPM_PACKAGE);
        if (modulePath) {
          const packageJSON = await readPackageJSON(dirname(modulePath));
          version = packageJSON.version ?? "latest";
          context.logger.debug(
            `[libreoffice] Resolved ${NPM_PACKAGE} version: ${version}`
          );
        }
      } catch (error) {
        context.logger.debug(
          `[libreoffice] Could not resolve ${NPM_PACKAGE} version, using "latest"`,
          { error }
        );
      }

      context.addLayer({
        id: "libreoffice-npm",
        dependencies: {
          [NPM_PACKAGE]: version,
        },
      });

      context.logger.debug(
        `[libreoffice] Added LibreOffice layer (minimal=${minimal})`
      );
    },
  };
}