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
  for: async (options: WaitOptions) => {},
  until: async (options: { date: Date; throwIfInThePast?: boolean }) => {},
  forRequest: async <TRequest>(params: RequestOptions): Promise<TRequest> => {
    return {} as any;
  },
};

type RequestOptions = {
  to: (url: string) => Promise<void>;
  timeout: WaitOptions;
};
