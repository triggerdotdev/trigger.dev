// The key panel, opened beside the needs attention page. The same route module as the list's key
// panel: the page tells it, through the outlet context, where it lives and where to close to.
export {
  default,
  loader,
  meta,
  shouldRevalidate,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.key.$keyParam/route";
