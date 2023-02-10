import { TemplateData } from "./TemplatesData";

export function TemplateOverview() {
  return (
    <div className="flex h-full w-full flex-col">
      <div>{TemplateData[0].title}</div>
      <div>{TemplateData[0].description}</div>
      <div>{TemplateData[0].githubRepoURL}</div>
    </div>
  );
}
