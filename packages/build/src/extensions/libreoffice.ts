import { BuildManifest } from "@trigger.dev/core/v3";
import { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";

export function libreoffice() {
  return new LibreOfficeExtension();
}

class LibreOfficeExtension implements BuildExtension {
  public readonly name = "LibreOfficeExtension";

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") {
      return;
    }

    context.logger.debug(`Adding ${this.name} to the build`);

    const instructions = [
      `RUN apt-get update && apt-get install -y \
    libreoffice \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*`,
    ];

    context.addLayer({
      id: "libreoffice",
      image: {
        instructions,
      },
    });
  }
}
