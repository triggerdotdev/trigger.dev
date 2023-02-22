export type ReturnResponse = {
  response: NormalizedResponse;
  isRetryable: boolean;
  ok: boolean;
};

export type NormalizedResponse = {
  output: NonNullable<any>;
  context: any;
};

export function error(
  status: number,
  isRetryable: boolean,
  error: Record<string, any>
): ReturnResponse {
  const response: ReturnResponse = {
    ok: false,
    isRetryable,
    response: {
      output: error,
      context: {
        statusCode: status,
        headers: {},
      },
    },
  };
  return response;
}
