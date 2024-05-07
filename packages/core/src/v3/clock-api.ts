// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { ClockAPI } from "./clock";
/** Entrypoint for clock API */
export const clock = ClockAPI.getInstance();
