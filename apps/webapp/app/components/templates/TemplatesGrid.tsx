export function TemplatesGrid() {
  return (
    <div className="flex w-full flex-wrap">
      <TemplateCard />
      <TemplateCard />
      <TemplateCard />
      <TemplateCard />
      <TemplateCard />
      <TemplateCard />
    </div>
  );
}

function TemplateCard() {
  return (
    <div>
      <p>build your card in here.</p>
    </div>
  );
}
