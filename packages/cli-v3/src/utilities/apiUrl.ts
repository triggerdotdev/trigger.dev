import { CLOUD_API_URL } from "../consts.js";

const CLOUD_API_HOST = new URL(CLOUD_API_URL).hostname;

// Analytics go to Trigger.dev Cloud's project only, and only for the production API.
export function isTriggerCloudApi(apiUrl: string | undefined): boolean {
  if (!apiUrl) return false;
  try {
    const url = new URL(apiUrl);
    return url.protocol === "https:" && url.hostname === CLOUD_API_HOST && url.port === "";
  } catch {
    return false;
  }
}
