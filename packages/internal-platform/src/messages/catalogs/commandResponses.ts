import { commandResponses as integrationRequests } from "../schemas/integrationRequests";
import { commandResponses as delays } from "../schemas/delays";

const Catalog = {
  ...integrationRequests,
  ...delays,
};

export default Catalog;
