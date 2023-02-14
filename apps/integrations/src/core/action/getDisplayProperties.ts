import { EndpointSpecMetadata } from "core/endpoint/types";
import { RequestData } from "core/request/types";

export async function getDisplayProperties(
  data: RequestData,
  displayProperties: EndpointSpecMetadata["displayProperties"]
) {
  return {
    title: interpolateString(displayProperties.title, {
      parameters: data.parameters,
      body: data.body,
    }),
  };
}

function interpolateString(
  template: string,
  data: Record<string | number, any>
) {
  return template.replace(/\${([^}]+)}/g, (_, key) => {
    return key
      .split(".")
      .reduce((obj: Record<string | number, any>, prop: string | number) => {
        return obj[prop];
      }, data);
  });
}
