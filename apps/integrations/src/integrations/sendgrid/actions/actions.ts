import { makeSimpleActions } from "core/action/makeAction";
import endpoints from "../endpoints/endpoints";

const actions = makeSimpleActions(endpoints);
export default actions;
