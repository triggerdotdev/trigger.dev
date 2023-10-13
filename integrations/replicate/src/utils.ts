import { CallbackTimeout } from "./types";

export const createPredictionProperties = (
  params: Partial<{
    version: string;
    stream: boolean;
  }>
) => {
  return [
    ...(params.version ? [{ label: "Model Version", text: params.version }] : []),
    ...streamingProperty(params),
  ];
};

export const createDeploymentProperties = (
  params: Partial<{
    deployment_owner: string;
    deployment_name: string;
    stream: boolean;
  }>
) => {
  return [
    ...(params.deployment_owner
      ? [{ label: "Deployment Owner", text: params.deployment_owner }]
      : []),
    ...(params.deployment_name ? [{ label: "Deployment Name", text: params.deployment_name }] : []),
    ...streamingProperty(params),
  ];
};

export const modelProperties = (
  params: Partial<{
    model_owner: string;
    model_name: string;
    version_id: string;
    destination: string;
  }>
) => {
  return [
    ...(params.model_owner ? [{ label: "Model Owner", text: params.model_owner }] : []),
    ...(params.model_name ? [{ label: "Model Name", text: params.model_name }] : []),
    ...(params.version_id ? [{ label: "Model Version", text: params.version_id }] : []),
    ...(params.destination ? [{ label: "Destination Model", text: params.destination }] : []),
  ];
};

export const streamingProperty = (params: { stream?: boolean }) => {
  return [{ label: "Streaming Enabled", text: String(!!params.stream) }];
};

export const callbackProperties = (options: CallbackTimeout) => {
  return [
    {
      label: "Callback Timeout",
      text: options.timeoutInSeconds ? `${options.timeoutInSeconds}s` : "default",
    },
  ];
};
