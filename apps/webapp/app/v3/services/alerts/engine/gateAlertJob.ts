export function gateAlertJob<T>(
  configured: boolean,
  handler: (input: T) => Promise<void>
): (input: T) => Promise<void> {
  return async (input) => {
    if (!configured) return;
    await handler(input);
  };
}
