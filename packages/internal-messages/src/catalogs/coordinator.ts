import initializeWorkflow from "../messages/initializeWorkflow";
import initiateIntegrationRequest from "../messages/initiateIntegrationRequest";

const Catalog = {
  ...initializeWorkflow,
  ...initiateIntegrationRequest,
};

export default Catalog;
