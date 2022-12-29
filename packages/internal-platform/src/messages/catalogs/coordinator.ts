import sendIntegrationRequest from "../schemas/sendIntegrationRequest";
import startWorklowRun from "../schemas/startWorkflowRun";
import failWorkflowRun from "../schemas/failWorkflowRun";
import completeWorkflowRun from "../schemas/completeWorkflowRun";
import logMessage from "../schemas/logMessage";
import triggerCustomEvent from "../schemas/triggerCustomEvent";
import awaits from "../schemas/awaits";

const Catalog = {
  ...sendIntegrationRequest,
  ...startWorklowRun,
  ...failWorkflowRun,
  ...completeWorkflowRun,
  ...logMessage,
  ...triggerCustomEvent,
  ...awaits,
};

export default Catalog;
