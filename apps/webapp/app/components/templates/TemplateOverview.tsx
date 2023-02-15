import { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { OctoKitty } from "../GitHubLoginButton";
import { TertiaryA, ToxicLink } from "../primitives/Buttons";
import { Body } from "../primitives/text/Body";
import { Header2 } from "../primitives/text/Headers";

export function TemplateOverview({ template }: { template: TemplateListItem }) {
  const { docsHTML, title, description, repositoryUrl, imageUrl, id } =
    template;

  return (
    <div className="flex w-full rounded-lg bg-slate-800 px-4 py-4 text-left">
        <div className="flex h-full w-full flex-col gap-y-4 rounded ">
          <div className="z-90 h-fit w-full border  border-slate-800 transition group-hover:opacity-90">
            <img
              src={imageUrl}
              alt=""
              className="h-full w-full rounded object-cover"
            />
          </div>
          <div className="flex rounded bg-slate-900/75 p-4">
            <div
              className="prose prose-sm prose-invert"
              dangerouslySetInnerHTML={{
                __html: docsHTML,
              }}
            />
          </div>
        </div>
        <div className="sticky top-4 ml-4 flex h-max w-[240px] min-w-[240px] flex-col rounded-r">
          <div className="flex flex-col gap-y-3 ">
            <ToxicLink
              size="large"
              className="group flex min-w-full h-12"
              to={`../../templates/add?templateId=${id}`}
            >
              <span> Use this template </span>
              <span
                className="ml-1 transition group-hover:translate-x-0.5"
                aria-hidden="true"
              >
                &rarr;
              </span>
            </ToxicLink>
            <Header2 size="regular" className="mt-4 font-semibold">
              {title}
            </Header2>
            <Body>{description}</Body>

            <div className="flex flex-row gap-x-1">
              {template.services.map((service) => (
                <div key={service.slug} className="">
                  <ApiLogoIcon
                    integration={service}
                    size="regular"
                    className="flex h-8 w-8 items-center justify-center rounded border-[1px] border-slate-700 bg-slate-900 transition group-hover:border-slate-600 group-hover:bg-slate-900/80"
                  />
                </div>
              ))}
            </div>

            <TertiaryA href={repositoryUrl} target="_blank">
              <OctoKitty className="h-4 w-4" />
              <Body size="extra-small" className="truncate font-mono">
                {repositoryUrl.replace("https://github.com/triggerdotdev", "")}
              </Body>
            </TertiaryA>
          </div>
        </div>
      </div>
  );
}
