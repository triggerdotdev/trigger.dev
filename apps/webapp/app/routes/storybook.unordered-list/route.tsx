import { Header2 } from "~/components/primitives/Headers";
import { Paragraph, type ParagraphVariant } from "~/components/primitives/Paragraph";
import { UnorderedList } from "~/components/primitives/UnorderedList";

const sampleItems = [
  "A new issue is seen for the first time",
  "A resolved issue re-occurs",
  "An ignored issue re-occurs depending on the settings you configured",
];

const variantGroups: { label: string; variants: ParagraphVariant[] }[] = [
  {
    label: "Base",
    variants: ["base", "base/bright"],
  },
  {
    label: "Small",
    variants: ["small", "small/bright", "small/dimmed"],
  },
  {
    label: "Extra small",
    variants: [
      "extra-small",
      "extra-small/bright",
      "extra-small/dimmed",
      "extra-small/mono",
      "extra-small/bright/mono",
      "extra-small/dimmed/mono",
      "extra-small/caps",
      "extra-small/bright/caps",
    ],
  },
  {
    label: "Extra extra small",
    variants: [
      "extra-extra-small",
      "extra-extra-small/bright",
      "extra-extra-small/caps",
      "extra-extra-small/bright/caps",
      "extra-extra-small/dimmed/caps",
    ],
  },
];

export default function Story() {
  return (
    <div className="flex flex-col gap-12 p-8">
      {variantGroups.map((group) => (
        <div key={group.label} className="flex flex-col gap-6">
          <Header2>{group.label}</Header2>
          {group.variants.map((variant) => (
            <div key={variant} className="flex flex-col">
              <code className="mb-2 font-mono text-xs text-charcoal-400">{variant}</code>
              <Paragraph variant={variant}>This is a paragraph before the list.</Paragraph>
              <UnorderedList variant={variant}>
                {sampleItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </UnorderedList>
              <Paragraph variant={variant}>This is a paragraph after the list.</Paragraph>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
