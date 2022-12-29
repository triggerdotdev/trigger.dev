import triggerWorkflow from "../schemas/triggerWorkflow";
import finishIntegrationRequest from "../schemas/finishIntegrationRequest";

const Catalog = {
  ...triggerWorkflow,
  ...finishIntegrationRequest,
};

export default Catalog;
