import { typedjson } from "remix-typedjson";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder.server";

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async () => {
    return typedjson({});
  }
);

export default function BackOfficeIndex() {
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <Header2>Back office</Header2>
      <Paragraph variant="base" className="max-w-prose">
        Back-office actions are applied to a single organization. Pick an org from the
        Organizations tab to open its detail page.
      </Paragraph>
      <LinkButton to="/admin/orgs" variant="primary/medium">
        Pick an organization
      </LinkButton>
    </div>
  );
}
