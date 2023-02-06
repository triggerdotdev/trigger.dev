import { commandResponses as integrationRequests } from "../schemas/integrationRequests";
import { commandResponses as delays } from "../schemas/delays";
import { commandResponses as fetchRequests } from "../schemas/fetchRequests";
import { commandResponses as runOnce } from "../schemas/runOnce";

const Catalog = {
  ...integrationRequests,
  ...delays,
  ...fetchRequests,
  ...runOnce,
};

export default Catalog;
