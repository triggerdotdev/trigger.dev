import { logger, task } from "@trigger.dev/sdk/v3";
import { chmod, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { basename } from "node:path";
import YTDlpWrap from "yt-dlp-wrap";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

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

async function getFfprobe() {
  const ffprobe = await import("@ffprobe-installer/ffprobe");

  logger.log("ffprobeInstaller", ffprobe);

  return ffprobe;
}

async function ffprobeVersion() {
  const ffprobe = await getFfprobe();
  const childProcess = await execute(ffprobe.path, ["-version"]);

  logger.log("ffprobe -version", {
    output: childProcess.stdout.split("\n")[0],
  });
}

async function ffmpegVersion() {
  logger.log("ffmpegInstaller", ffmpeg);

  const childProcess = await execute(ffmpeg.path, ["-version"]);

  logger.log("ffmpeg -version", {
    output: childProcess.stdout.split("\n")[0],
  });
}

export const ffprobeInstaller = task({
  id: "ffprobe-installer",
  run: async () => {
    await ffprobeVersion();
  },
});

export const ffmpegInstaller = task({
  id: "ffmpeg-installer",
  run: async () => {
    await ffmpegVersion();
  },
});

const videoUrl =
  "https://upload.wikimedia.org/wikipedia/commons/0/07/Fractal-zoom-1-03-Mandelbrot_Buzzsaw.ogv";
const videoPath = "./video.ogv";

async function downloadVideo() {
  logger.log("downloading video", { url: videoUrl });

  const response = await fetch(videoUrl);

  if (!response.body) {
    throw new Error("No readable stream");
  }

  const readStream = Readable.fromWeb(response.body as ReadableStream);
  await writeFile(videoPath, readStream);

  logger.log("finished downloading", { outputPath: videoPath });
}

async function execute(file: string, args?: readonly string[]) {
  const { execa } = await import("execa");

  logger.log(`execute: ${basename(file)}`, { args });
  const childProcess = await execa(file, args);

  if (childProcess.exitCode !== 0) {
    logger.error("Non-zero exit code", {
      stderr: childProcess.stderr,
      stdout: childProcess.stdout,
    });
    throw new Error("Non-zero exit code");
  }

  return childProcess;
}

async function probeVideo() {
  const ffprobe = await getFfprobe();
  const args = ["-hide_banner", "-print_format", "json", "-show_format", videoPath];

  logger.log("probing video", { videoPath });
  const childProcess = await execute(ffprobe.path, args);

  logger.log("video info", {
    output: JSON.parse(childProcess.stdout),
  });
}

export const ffprobeInfo = task({
  id: "ffprobe-info",
  run: async () => {
    await ffprobeVersion();
    await downloadVideo();
    await probeVideo();
  },
});

async function convertVideo() {
  const outputPath = "./video.webm";
  logger.log("converting video", { input: videoPath, output: outputPath });

  const childProcess = await execute(ffmpeg.path, [
    "-hide_banner",
    "-y", // overwrite output, don't prompt
    "-i",
    videoPath,
    // seek to 25s
    "-ss",
    "25",
    // stop after 5s
    "-t",
    "5",
    outputPath,
  ]);

  logger.log("video converted", {
    input: videoPath,
    output: outputPath,
    stderr: childProcess.stderr,
    stdout: childProcess.stdout,
  });
}

export const ffmpegConvert = task({
  id: "ffmpeg-convert",
  run: async () => {
    await ffmpegVersion();
    await downloadVideo();
    await convertVideo();
  },
});
