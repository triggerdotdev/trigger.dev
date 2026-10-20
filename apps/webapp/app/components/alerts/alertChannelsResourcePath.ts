export function alertChannelsResourcePath(
  projectId: string,
  withForm = false,
  environmentId?: string
) {
  return `/resources/alerts/channels?projectId=${projectId}${withForm ? "&form=1" : ""}${
    environmentId ? `&environmentId=${environmentId}` : ""
  }`;
}
