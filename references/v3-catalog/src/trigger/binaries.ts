import { logger, task } from "@trigger.dev/sdk/v3";
import { chmod } from "node:fs/promises";
import YTDlpWrap from "yt-dlp-wrap";

export const ytDlp = task({
  id: "yt-dlp",
  run: async () => {
    const releaseArtifact = "yt-dlp_linux";
    const filePath = `./${releaseArtifact}`;
    const fileURL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${releaseArtifact}`;

    await YTDlpWrap.downloadFile(fileURL, filePath);
    await chmod(filePath, "777");

    logger.log("downloaded", { filePath, fileURL });

    const ytDlpWrap = new YTDlpWrap(filePath);
    const version = await ytDlpWrap.getVersion();

    logger.log("version", { version });
  },
});
