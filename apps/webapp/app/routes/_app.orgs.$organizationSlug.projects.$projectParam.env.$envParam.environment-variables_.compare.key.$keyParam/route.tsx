// The key panel, opened beside the compare view. The same route module as the list's key panel:
// the compare view tells it, through the outlet context, to be read-only and where to close to.
export {
  default,
  loader,
  meta,
  shouldRevalidate,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.key.$keyParam/route";
