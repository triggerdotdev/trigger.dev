// The create dialog over the needs attention page's key panel ("Set" on a key missing here). The
// same route module as the list's: it reads the page it is on from the URL to come back to it.
export {
  action,
  default,
  meta,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route";
