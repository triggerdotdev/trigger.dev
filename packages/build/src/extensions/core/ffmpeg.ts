import { BuildExtension } from "@trigger.dev/core/v3/build";

export type FfmpegOptions = {
  version?: string;
};

/**
 * Add ffmpeg to the build, and automatically set the FFMPEG_PATH and FFPROBE_PATH environment variables.
 * @param options.version The version of ffmpeg to install. If not provided, the latest version will be installed.
 *
 * @returns The build extension.
 */
export function ffmpeg(options: FfmpegOptions = {}): BuildExtension {
  return {
    name: "ffmpeg",
    onBuildComplete(context) {
      if (context.target === "dev") {
        return;
      }

      context.logger.debug("Adding ffmpeg", {
        options,
      });

      context.addLayer({
        id: "ffmpeg",
        image: {
          pkgs: options.version ? [`ffmpeg=${options.version}`] : ["ffmpeg"],
        },
        deploy: {
          env: {
            FFMPEG_PATH: "/usr/bin/ffmpeg",
            FFPROBE_PATH: "/usr/bin/ffprobe",
          },
          override: true,
        },
      });
    },
  };
}
