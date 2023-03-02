import { InputSpec } from "core/action/types";

export function createParametersBody(
  inputSpec: InputSpec,
  params?: Record<string | number, any> | undefined
) {
  //separate the parameters and body by looking at the spec and pulling properties out
  let parameters: Record<string, any> | undefined = undefined;
  let body: any = undefined;

  if (params) {
    inputSpec.parameters?.forEach((p) => {
      if (!parameters) {
        parameters = {};
      }
      parameters[p.name] = params[p.name];
    });

    //everything left should go in the body
    if (inputSpec.body) {
      body = {};
      Object.keys(params).forEach((name) => {
        if (!inputSpec.parameters?.find((p) => p.name === name)) {
          body[name] = params[name];
        }
      });
    }
  }

  return {
    parameters,
    body,
  };
}
