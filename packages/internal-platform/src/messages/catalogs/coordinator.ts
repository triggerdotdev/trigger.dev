import { coordinator as integrationRequests } from "../schemas/integrationRequests";
import { coordinator as workflowRuns } from "../schemas/workflowRuns";
import { coordinator as logs } from "../schemas/logs";
import { coordinator as customEvents } from "../schemas/customEvents";
import { coordinator as delays } from "../schemas/delays";

const Catalog = {
  ...integrationRequests,
  ...workflowRuns,
  ...logs,
  ...customEvents,
  ...delays,
};

export default Catalog;
