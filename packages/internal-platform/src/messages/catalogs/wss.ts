import { wss as integrationRequests } from "../schemas/integrationRequests";
import { wss as workflowRuns } from "../schemas/workflowRuns";
import { wss as logs } from "../schemas/logs";
import { wss as customEvents } from "../schemas/customEvents";
import { wss as delays } from "../schemas/delays";

const Catalog = {
  ...integrationRequests,
  ...workflowRuns,
  ...logs,
  ...customEvents,
  ...delays,
};

export default Catalog;
