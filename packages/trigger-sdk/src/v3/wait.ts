import { SemanticInternalAttributes, accessoryAttributes, runtime } from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

export type WaitOptions =
  | {
      seconds: number;
    }
  | {
      minutes: number;
    }
  | {
      hours: number;
    }
  | {
      days: number;
    }
  | {
      weeks: number;
    }
  | {
      months: number;
    }
  | {
      years: number;
    };

export const wait = {
  for: async (options: WaitOptions) => {
    return tracer.startActiveSpan(
      `wait.for()`,
      async (span) => {
        const start = Date.now();
        const durationInMs = calculateDurationInMs(options);

        await runtime.waitForDuration(durationInMs);
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "wait",
          ...accessoryAttributes({
            items: [
              {
                text: nameForWaitOptions(options),
                variant: "normal",
              },
            ],
            style: "codepath",
          }),
        },
      }
    );
  },
  until: async (options: { date: Date; throwIfInThePast?: boolean }) => {
    return tracer.startActiveSpan(
      `wait.until()`,
      async (span) => {
        const start = Date.now();

        if (options.throwIfInThePast && options.date < new Date()) {
          throw new Error("Date is in the past");
        }

        const durationInMs = options.date.getTime() - start;

        await runtime.waitForDuration(durationInMs);
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "wait",
          ...accessoryAttributes({
            items: [
              {
                text: options.date.toISOString(),
                variant: "normal",
              },
            ],
            style: "codepath",
          }),
        },
      }
    );
  },
};

function nameForWaitOptions(options: WaitOptions): string {
  if ("seconds" in options) {
    return options.seconds === 1 ? `1 second` : `${options.seconds} seconds`;
  }

  if ("minutes" in options) {
    return options.minutes === 1 ? `1 minute` : `${options.minutes} minutes`;
  }

  if ("hours" in options) {
    return options.hours === 1 ? `1 hour` : `${options.hours} hours`;
  }

  if ("days" in options) {
    return options.days === 1 ? `1 day` : `${options.days} days`;
  }

  if ("weeks" in options) {
    return options.weeks === 1 ? `1 week` : `${options.weeks} weeks`;
  }

  if ("months" in options) {
    return options.months === 1 ? `1 month` : `${options.months} months`;
  }

  if ("years" in options) {
    return options.years === 1 ? `1 year` : `${options.years} years`;
  }

  return "NaN";
}

function calculateDurationInMs(options: WaitOptions): number {
  if ("seconds" in options) {
    return options.seconds * 1000;
  }

  if ("minutes" in options) {
    return options.minutes * 1000 * 60;
  }

  if ("hours" in options) {
    return options.hours * 1000 * 60 * 60;
  }

  if ("days" in options) {
    return options.days * 1000 * 60 * 60 * 24;
  }

  if ("weeks" in options) {
    return options.weeks * 1000 * 60 * 60 * 24 * 7;
  }

  if ("months" in options) {
    return options.months * 1000 * 60 * 60 * 24 * 30;
  }

  if ("years" in options) {
    return options.years * 1000 * 60 * 60 * 24 * 365;
  }

  throw new Error("Invalid options");
}

type RequestOptions = {
  to: (url: string) => Promise<void>;
  timeout: WaitOptions;
};
