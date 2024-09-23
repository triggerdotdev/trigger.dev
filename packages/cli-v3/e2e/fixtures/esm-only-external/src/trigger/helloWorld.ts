import { task } from "@trigger.dev/sdk/v3";
import * as mupdf from "mupdf";

export const helloWorld = task({
  id: "helloWorld",
  run: async () => {
    console.log("Hello, World!", {
      metaformat: mupdf.PDFDocument.META_FORMAT,
    });
  },
});
