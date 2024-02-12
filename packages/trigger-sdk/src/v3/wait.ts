import { runtime } from "@trigger.dev/core/v3";

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
    const durationInMs = calculateDurationInMs(options);

    await runtime.waitForDuration(durationInMs);
  },
  until: async (options: { date: Date; throwIfInThePast?: boolean }) => {},
  forRequest: async <TRequest>(params: RequestOptions): Promise<TRequest> => {
    return {} as any;
  },
};

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
