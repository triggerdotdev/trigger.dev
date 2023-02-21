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

    const bodyProperties = inputSpec.body?.properties;
    if (bodyProperties) {
      body = {};
      Object.keys(bodyProperties).forEach((name) => {
        const value = params?.[name];
        if (value !== undefined) {
          body[name] = value;
        }
      });
    }
  }

  return {
    parameters,
    body,
  };
}
