import { makeSimpleActions } from "core/action/makeAction";
import endpoints from "../endpoints/endpoints";

const actions = makeSimpleActions(
  endpoints,
  (specs) => {
    const paramsWithoutVersion = specs.input.parameters?.filter(
      (p) => p.name !== "Notion-Version"
    );
    return {
      input: {
        ...specs.input,
        parameters: paramsWithoutVersion,
      },
      output: specs.output,
    };
  },
  (data) => {
    data.parameters = {
      ...data.parameters,
      "Notion-Version": "2022-06-28",
    };
    return data;
  }
);
export default actions;
