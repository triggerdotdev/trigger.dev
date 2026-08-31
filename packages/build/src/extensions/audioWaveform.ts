import { BuildManifest } from "@trigger.dev/core/v3";
import { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";

export type AudioWaveformOptions = {
  version?: string;
  checksum?: string;
};

const AUDIOWAVEFORM_VERSION = "1.10.1";
const AUDIOWAVEFORM_CHECKSUM =
  "sha256:00b41ea4d6e7a5b4affcfe4ac99951ec89da81a8cba40af19e9b98c3a8f9b4b8";

export function audioWaveform(options: AudioWaveformOptions = {}): BuildExtension {
  return new AudioWaveformExtension(options);
}

class AudioWaveformExtension implements BuildExtension {
  public readonly name = "AudioWaveformExtension";

  constructor(private options: AudioWaveformOptions = {}) {}

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") {
      return;
    }

    const opts = this.options.version
      ? {
          version: this.options.version,
          checksum: this.options.checksum,
        }
      : {
          version: AUDIOWAVEFORM_VERSION,
          checksum: AUDIOWAVEFORM_CHECKSUM,
        };

    context.logger.debug("Adding audiowaveform to the build", {
      ...opts,
    });

    const instructions = [
      `ADD ${
        opts.checksum ? `--checksum=${opts.checksum}` : ""
      } https://github.com/bbc/audiowaveform/releases/download/${opts.version}/audiowaveform_${
        opts.version
      }-1-12_amd64.deb .`,
      `RUN dpkg -i audiowaveform_${opts.version}-1-12_amd64.deb || true`,
      `RUN rm audiowaveform*.deb`,
    ];

    context.addLayer({
      id: "audiowaveform",
      image: {
        pkgs: ["sox"],
        instructions,
      },
    });
  }
}
