// Each field is a Lua expression evaluated inside the target script. queueLimit/
// envLimit must be the EFFECTIVE enforced limit, else an unset limit reads as throttled.
export type GaugeComputeLuaParams = {
  // Lua boolean expression; when true the gauge is computed (else the extra reads are skipped).
  enabledArg: string;
  queued: string;
  running: string;
  queueLimit: string;
  envQueued: string;
  envRunning: string;
  envLimit: string;
  // Lua statements run first inside the pcall (e.g. to compute aggregate locals).
  preamble?: string;
  // Lua boolean expression (in __cc/__lim/__ql) for the throttled flag. Pass "false"
  // where cc >= lim is not a valid throttle signal (e.g. summed CK aggregates).
  throttledExpr?: string;
  // CK-health extras (both or neither): appended as an optional gauge tail, gauge[8]/gauge[9].
  ckBacklogged?: string;
  ckMaxWaitMs?: string;
  // Total-concurrency extras (both or neither, and only with the CK extras): appended as
  // gauge[10]/gauge[11]. totalLimit is the RAW stored limit (0 = none); readers clamp.
  totalRunning?: string;
  totalLimit?: string;
};

// Computes an op=gauge snapshot into the enclosing script's `__qm_g` local (a flat
// {ql, cc, lim, eql, ec, elim, thr} array) so the script can RETURN it; Node then XADDs it
// to the metrics Redis. No Redis write here (the run-queue Redis carries no metrics stream).
// Gated on the sample flag and pcall-wrapped. The script MUST declare `local __qm_g` first.
export function createMetricsGaugeComputeLua(params: GaugeComputeLuaParams): string {
  const throttled = params.throttledExpr ?? "__cc >= __lim and __ql > 0";
  const hasCk = params.ckBacklogged != null && params.ckMaxWaitMs != null;
  const hasTotal = params.totalRunning != null && params.totalLimit != null;
  if (hasTotal && !hasCk) {
    throw new Error("gauge totalRunning/totalLimit extras require the CK extras");
  }
  const gauge = hasTotal
    ? `    local __ckq = tonumber(${params.ckBacklogged}) or 0
    local __ckw = tonumber(${params.ckMaxWaitMs}) or 0
    local __tcc = tonumber(${params.totalRunning}) or 0
    local __tlim = tonumber(${params.totalLimit}) or 0
    __qm_g = {__ql, __cc, __lim, __eql, __ec, __elim, __thr, __ckq, __ckw, __tcc, __tlim}`
    : hasCk
      ? `    local __ckq = tonumber(${params.ckBacklogged}) or 0
    local __ckw = tonumber(${params.ckMaxWaitMs}) or 0
    __qm_g = {__ql, __cc, __lim, __eql, __ec, __elim, __thr, __ckq, __ckw}`
      : `    __qm_g = {__ql, __cc, __lim, __eql, __ec, __elim, __thr}`;

  return `
if ${params.enabledArg} then
  pcall(function()
    ${params.preamble ?? ""}
    local __ql = tonumber(${params.queued}) or 0
    local __cc = tonumber(${params.running}) or 0
    local __lim = tonumber(${params.queueLimit}) or 0
    local __eql = tonumber(${params.envQueued}) or 0
    local __ec = tonumber(${params.envRunning}) or 0
    local __elim = tonumber(${params.envLimit}) or 0
    local __thr = 0
    if ${throttled} then __thr = 1 end
${gauge}
  end)
end`;
}
