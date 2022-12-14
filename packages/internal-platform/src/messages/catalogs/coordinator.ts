import initializeWorkflow from "../schemas/initializeWorkflow";
import initiateIntegrationRequest from "../schemas/initiateIntegrationRequest";

const Catalog = {
  ...initializeWorkflow,
  ...initiateIntegrationRequest,
};

export default Catalog;
