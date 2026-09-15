import { ComponentNames } from "../storybook/StoryKit";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";

export default function Story() {
  return (
    <div className="flex flex-col gap-4 bg-background-bright p-4">
      <div className="px-4 pt-4">
        <ComponentNames names={["PageHeader.tsx"]} />
      </div>
      <div className="bg-background-bright">
        <NavBar>
          <PageTitle title="Organizations" />
          <PageAccessories>
            <LinkButton to={""} variant="primary/small" shortcut={{ key: "n" }}>
              Create a new Organization
            </LinkButton>
          </PageAccessories>
        </NavBar>
      </div>
      <div className="bg-background-bright">
        <NavBar>
          <PageTitle title="Your Organizations" backButton={{ to: "#", text: "Orgs" }} />
          <PageAccessories>
            <LinkButton to={""} variant="primary/small" shortcut={{ key: "n" }}>
              Create a new Organization
            </LinkButton>
          </PageAccessories>
        </NavBar>
      </div>
    </div>
  );
}
