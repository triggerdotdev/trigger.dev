export function shouldReportAttemptInvocation(run: { attemptNumber: number }): boolean {
  return run.attemptNumber === 1;
}
