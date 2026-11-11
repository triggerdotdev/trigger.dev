// The create dialog, opened over the key panel so the panel stays open under it. The same
// route module as the list's own create dialog: it reads the open key from the URL to start on
// it and to come back to the panel.
export {
  action,
  default,
  meta,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route";
