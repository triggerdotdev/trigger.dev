import { defineConfig } from "@trigger.dev/sdk/v3";
import { libreoffice } from "@trigger.dev/build/extensions/libreoffice";

export default defineConfig({
  project: "proj_libreoffice_example",
  build: {
    extensions: [
      // Installs libreoffice-writer and libreoffice-impress (headless, no X11)
      // along with fonts-liberation and fonts-dejavu-core for accurate rendering.
      libreoffice(),
    ],
  },
});
