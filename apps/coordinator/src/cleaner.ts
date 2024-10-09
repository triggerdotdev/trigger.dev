import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { Exec } from "./exec";
import { setTimeout } from "timers/promises";

interface TempFileCleanerOptions {
  paths: string[];
  maxAgeMinutes: number;
  intervalSeconds: number;
  leadingEdge?: boolean;
}

export class TempFileCleaner {
  private enabled = false;

  private logger: SimpleStructuredLogger;
  private exec: Exec;

  constructor(private opts: TempFileCleanerOptions) {
    this.logger = new SimpleStructuredLogger("tmp-cleaner", undefined, { ...this.opts });
    this.exec = new Exec({ logger: this.logger });
  }

  async start() {
    this.logger.log("TempFileCleaner.start");
    this.enabled = true;

    if (!this.opts.leadingEdge) {
      await this.wait();
    }

    while (this.enabled) {
      try {
        await this.clean();
      } catch (error) {
        this.logger.error("error during tick", { error });
      }

      await this.wait();
    }
  }

  stop() {
    this.logger.log("TempFileCleaner.stop");
    this.enabled = false;
  }

  private wait() {
    return setTimeout(this.opts.intervalSeconds * 1000);
  }

  private async clean() {
    for (const path of this.opts.paths) {
      try {
        await this.cleanSingle(path);
      } catch (error) {
        this.logger.error("error while cleaning", { path, error });
      }
    }
  }

  private async cleanSingle(startingPoint: string) {
    const maxAgeMinutes = this.opts.maxAgeMinutes;

    const ignoreStartingPoint = ["!", "-path", startingPoint];
    const onlyDirectDescendants = ["-maxdepth", "1"];
    const onlyOldFiles = ["-mmin", `+${maxAgeMinutes}`];

    const baseArgs = [
      startingPoint,
      ...ignoreStartingPoint,
      ...onlyDirectDescendants,
      ...onlyOldFiles,
    ];

    const duArgs = ["-exec", "du", "-ch", "{}", "+"];
    const rmArgs = ["-exec", "rm", "-rf", "{}", "+"];

    const du = this.x("find", [...baseArgs, ...duArgs]);
    const duOutput = await du;

    const duLines = duOutput.stdout.trim().split("\n");
    const fileCount = duLines.length - 1; // last line is the total
    const fileSize = duLines.at(-1)?.trim().split(/\s+/)[0];

    if (fileCount === 0) {
      this.logger.log("nothing to delete", { startingPoint, maxAgeMinutes });
      return;
    }

    this.logger.log("deleting old files", { fileCount, fileSize, startingPoint, maxAgeMinutes });

    const rm = this.x("find", [...baseArgs, ...rmArgs]);
    const rmOutput = await rm;

    if (rmOutput.stderr.length > 0) {
      this.logger.error("delete unsuccessful", { rmOutput });
      return;
    }

    this.logger.log("deleted old files", { fileCount, fileSize, startingPoint, maxAgeMinutes });
  }

  private get x() {
    return this.exec.x.bind(this.exec);
  }
}
