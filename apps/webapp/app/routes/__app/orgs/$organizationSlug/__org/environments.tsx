import { EyeIcon, EyeSlashIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import invariant from "tiny-invariant";
import { CopyTextPanel } from "~/components/CopyTextButton";
import { EnvironmentBanner } from "~/components/EnvironmentBanner";
import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import { Panel } from "~/components/layout/Panel";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";
import { TertiaryButton } from "~/components/primitives/Buttons";
import { Body } from "~/components/primitives/text/Body";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { EnvironmentIcon } from "~/routes/resources/environment";
import { titleCase } from "~/utils";

export default function Page() {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization must be defined");
  const [isShowingKeys, setIsShowingKeys] = useState(false);

  return (
    <AppLayoutTwoCol>
      <OrganizationsSideMenu />
      <AppBody>
        <Header context="workflows" />
        <Container>
          <Title>API Keys</Title>
          <SubTitle>Copy these API keys into your workflow code</SubTitle>
          <Panel>
            <div className="mb-1">
              {!isShowingKeys ? (
                <TertiaryButton
                  onClick={() => setIsShowingKeys(true)}
                  className="group transition"
                >
                  <EyeIcon className="mr-0.5 h-4 w-4 text-slate-500 transition group-hover:text-slate-400" />
                  Show keys
                </TertiaryButton>
              ) : (
                <TertiaryButton
                  onClick={() => setIsShowingKeys(false)}
                  className="group transition"
                >
                  <EyeSlashIcon className="mr-0.5 h-4 w-4 text-slate-500 transition group-hover:text-slate-400" />
                  Hide keys
                </TertiaryButton>
              )}
            </div>
            <ul className="flex flex-col gap-2">
              {organization.environments.map((environment) => {
                return (
                  <li
                    key={environment.id}
                    className="flex w-full flex-col justify-between"
                  >
                    <div className="relative flex max-w-md items-center">
                      <EnvironmentIcon
                        slug={environment.slug}
                        className="absolute top-5 left-3"
                      />
                      <CopyTextPanel
                        value={environment.apiKey}
                        text={
                          isShowingKeys
                            ? environment.apiKey
                            : `${titleCase(environment.slug)}`
                        }
                        variant="slate"
                        className="pt-3 pb-3 pl-7 text-slate-300 hover:text-slate-300"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
          <Body size="small" className="mt-3 text-slate-500">
            Use the Live key for production and the Development key for local.
            Learn more about API keys{" "}
            <a
              href="https://docs.trigger.dev/guides/environments"
              target="_blank"
              className="underline underline-offset-2 transition hover:text-slate-200"
              rel="noreferrer"
            >
              here
            </a>
            .
          </Body>
        </Container>
      </AppBody>
    </AppLayoutTwoCol>
  );
}
