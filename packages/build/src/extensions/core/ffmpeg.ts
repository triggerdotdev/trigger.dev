import { BuildExtension } from "@trigger.dev/core/v3/build";

export type FfmpegOptions = {
  /**
   * The version of ffmpeg to install. If not provided, the latest version from apt will be installed.
   * If set to '7' or starts with '7.', a static build of ffmpeg 7.x from johnvansickle.com will be used instead of apt.
   * @example
   *   ffmpeg() // Installs latest ffmpeg from apt
   *   ffmpeg({ version: '7' }) // Installs static build of ffmpeg 7.x
   *   ffmpeg({ version: '7.0.1' }) // Installs static build of ffmpeg 7.x
   *   ffmpeg({ version: '6' }) // Version ignored, installs latest ffmpeg from apt
   *   ffmpeg({ version: '8' }) // Version ignored, installs latest ffmpeg from apt
   */
  version?: string;
};

/**
 * Add ffmpeg to the build, and automatically set the FFMPEG_PATH and FFPROBE_PATH environment variables.
 * @param options.version The version of ffmpeg to install. If not provided, the latest version from apt will be installed.
 * If set to '7' or starts with '7.', a static build of ffmpeg 7.x from johnvansickle.com will be used instead of apt.
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

      // Use static build for version 7 or 7.x
      if (options.version === "7" || options.version?.startsWith("7.")) {
        context.addLayer({
          id: "ffmpeg7",
          image: {
            instructions: [
              // Install ffmpeg after checksum validation
              "RUN apt-get update && apt-get install -y --no-install-recommends wget xz-utils nscd ca-certificates && apt-get clean && rm -rf /var/lib/apt/lists/* && " +
                "wget https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz.md5 && " +
                "wget https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz && " +
                "md5sum -c ffmpeg-git-amd64-static.tar.xz.md5 && " +
                "tar xvf ffmpeg-git-amd64-static.tar.xz -C /usr/bin --strip-components=1 --no-anchored 'ffmpeg' 'ffprobe' && " +
                "rm ffmpeg-git-amd64-static.tar.xz*",
            ],
          },
          deploy: {
            env: {
              FFMPEG_PATH: "/usr/bin/ffmpeg",
              FFPROBE_PATH: "/usr/bin/ffprobe",
            },
            override: true,
          },
        });
        return;
      } else if (options.version) {
        context.logger.warn("Custom ffmpeg version not supported, ignoring", {
          version: options.version,
        });
      }

      // Default: use apt
      context.addLayer({
        id: "ffmpeg",
        image: {
          pkgs: ["ffmpeg"],
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
    name: "ffmpeg7",
    onBuildComplete(context) {
      if (context.target === "dev") {
        return;
      }

      context.logger.debug("Adding ffmpeg 7");

      context.addLayer({
        id: "ffmpeg7",
        image: {
          instructions:[
            "RUN apt-get update && apt-get install -y --no-install-recommends wget xz-utils && apt-get clean && rm -rf /var/lib/apt/lists/*",
            "RUN wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -O ffmpeg.tar.xz && tar xvf ffmpeg.tar.xz -C /usr/bin --strip-components=1 --no-anchored 'ffmpeg' 'ffprobe' && rm ffmpeg.tar.xz",
          ],
        },
        deploy: {
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