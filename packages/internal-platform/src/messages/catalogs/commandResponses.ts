import { commandResponses as integrationRequests } from "../schemas/integrationRequests";
import { commandResponses as delays } from "../schemas/delays";
import { commandResponses as fetchRequests } from "../schemas/fetchRequests";

const Catalog = {
  ...integrationRequests,
  ...delays,
  ...fetchRequests,
};

export default Catalog;
