import { makeSimpleAction } from "core/action/makeAction";
import { Action } from "core/action/types";
import endpoints from "../endpoints/endpoints";

export const getRecord: Action = makeSimpleAction(endpoints.getRecord);
