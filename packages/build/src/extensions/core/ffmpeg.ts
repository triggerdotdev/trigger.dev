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

/**
 * Add ffmpeg 7.x to the build, and automatically set the FFMPEG_PATH and FFPROBE_PATH environment variables.
 * This uses the static build from johnvansickle.com to install the latest 7.x version.
 *
 * @returns The build extension.
 */

export function ffmpeg7(): BuildExtension {
  return {
    name:"ffmpeg7",
    onBuildComplete(context) {
      if(context.target === "dev") {
        return;
      }

      context.logger.debug("Adding ffmpeg 7");

      context.addLayer({
        id:"ffmpeg7",
        image: {
          instructions:[
            "RUN apt-get update && apt-get install -y --no-install-recommends wget xz-utils && apt-get clean && rm -rf /var/lib/apt/lists/*",
            "RUN wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -O ffmpeg.tar.xz && tar xvf ffmpeg.tar.xz -C /usr/bin --strip-components=1 --no-anchored 'ffmpeg' 'ffprobe' && rm ffmpeg.tar.xz",
          ],
        },
        deploy : {
          env: {
            FFMPEG_PATH: "/usr/bin/ffmpeg",
            FFPROBE_PATH: "/usr/bin/ffprobe",
          },
          override: true,
        }
      })
    }
  }
}