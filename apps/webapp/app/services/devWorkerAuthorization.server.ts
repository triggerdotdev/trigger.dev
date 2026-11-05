// Operating a local dev worker: fetching dev config, dequeuing, running attempts, and
// registering worker versions. Root keys hold `admin` and already pass.
export const DEV_WORKER_ACTION = "write";
export const DEV_WORKER_RESOURCE = { type: "devWorkers" } as const;

export const devWorkerAuthorization = {
  action: DEV_WORKER_ACTION,
  resource: () => DEV_WORKER_RESOURCE,
};
