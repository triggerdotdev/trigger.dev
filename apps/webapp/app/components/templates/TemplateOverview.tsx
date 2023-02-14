import { marked } from "marked";
import { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { OctoKitty } from "../GitHubLoginButton";
import { PrimaryLink, TertiaryA } from "../primitives/Buttons";
import { Body } from "../primitives/text/Body";
import { Header2 } from "../primitives/text/Headers";

export function TemplateOverview({ template }: { template: TemplateListItem }) {
  const { markdownDocs, title, description, repositoryUrl, imageUrl, id } =
    template;

  return (
    <div className="rounded-lg bg-slate-800 px-4 pb-4 text-left">
      <div className="z-90 sticky top-0 h-[200px] w-full border border-t-[20px] border-slate-800 transition group-hover:opacity-90">
        <img
          src={imageUrl}
          alt=""
          className="h-full w-full rounded object-cover"
        />
      </div>{" "}
      <div className="sticky top-[200px] h-[20px] w-full bg-gradient-to-b from-slate-800"></div>
      <div className="flex flex-row">
        <div className="flex h-full w-full flex-col gap-y-1 rounded ">
          <div className="flex rounded bg-slate-900/75 p-4">
            <p
              className="prose prose-sm prose-invert"
              dangerouslySetInnerHTML={{
                __html: marked(markdownDocs),
              }}
            />
          </div>
        </div>
        <div className="sticky top-[220px] ml-2 flex h-max w-[240px] min-w-[240px] flex-col gap-y-3 rounded-r  px-4">
          {template.services.map((service) => (
            <div
              key={service.slug}
              className=" mb-1 flex h-8 w-8 items-center justify-center rounded border-[1px] border-slate-700 bg-slate-900 transition group-hover:border-slate-800 group-hover:bg-slate-900"
            >
              <ApiLogoIcon integration={service} size="regular" />
            </div>
          ))}

          <Header2 size="regular" className="font-semibold">
            {title}
          </Header2>
          <Body>{description}</Body>

          <TertiaryA href={repositoryUrl} target="_blank">
            <OctoKitty className="h-4 w-4" />
            <Body className="font-mono ">{repositoryUrl}</Body>
          </TertiaryA>

          <PrimaryLink
            className="mt-2 w-full"
            to={`../../templates/add?templateId=${id}`}
          >
            Use this template
          </PrimaryLink>
        </div>
      </div>
    </div>
  );
}
