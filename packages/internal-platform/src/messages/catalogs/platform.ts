import { platform as workflows } from "../schemas/workflows";
import { platform as integrationRequests } from "../schemas/integrationRequests";
import { platform as delays } from "../schemas/delays";

const Catalog = {
  ...workflows,
  ...integrationRequests,
  ...delays,
};

export default Catalog;
