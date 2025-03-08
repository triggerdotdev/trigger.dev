import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";

export default function Story() {
  return (
    <div className="flex gap-x-8 p-8">
      <div className="flex flex-col items-start whitespace-nowrap">
        <Header2 className="mb-[2.2rem]">Variants</Header2>
        <div className="mb-10 space-y-[2.33rem]">
          <Paragraph variant="small/bright">primary/small</Paragraph>
          <Paragraph variant="small/bright">secondary/small</Paragraph>
          <Paragraph variant="small/bright">tertiary/small</Paragraph>
          <Paragraph variant="small/bright">tertiary/small + LeadingIcon</Paragraph>
          <Paragraph variant="small/bright">tertiary/small + LeadingIcon</Paragraph>
          <Paragraph variant="small/bright">primary/small + iconButton</Paragraph>
          <Paragraph variant="small/bright">secondary/small + iconButton</Paragraph>
          <Paragraph variant="small/bright">tertiary/small + iconButton</Paragraph>
        </div>
        <div className="space-y-[2.9rem]">
          <Paragraph variant="small/bright">primary/medium</Paragraph>
          <Paragraph variant="small/bright">secondary/medium</Paragraph>
          <Paragraph variant="small/bright">tertiary/medium</Paragraph>
          <Paragraph variant="small/bright">tertiary/medium + LeadingIcon</Paragraph>
          <Paragraph variant="small/bright">tertiary/medium + LeadingIcon</Paragraph>
          <Paragraph variant="small/bright">primary/medium + iconButton</Paragraph>
          <Paragraph variant="small/bright">secondary/medium + iconButton</Paragraph>
          <Paragraph variant="small/bright">tertiary/medium + iconButton</Paragraph>
        </div>
      </div>
      <div className="flex flex-col items-start gap-y-8">
        <Header2>Default</Header2>
        <ClipboardField value="copy paste me" variant="primary/small" />
        <ClipboardField value="copy paste me" variant="secondary/small" />
        <ClipboardField value="copy paste me" variant="tertiary/small" />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/small"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
        />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/small"
          icon={<MagnifyingGlassIcon className="size-4" />}
        />
        <ClipboardField value="with iconButton" variant="primary/small" iconButton />
        <ClipboardField value="with iconButton" variant="secondary/small" iconButton />
        <ClipboardField value="with iconButton" variant="tertiary/small" iconButton />
        <ClipboardField value="copy paste me" variant="primary/medium" />
        <ClipboardField value="copy paste me" variant="secondary/medium" />
        <ClipboardField value="copy paste me" variant="tertiary/medium" />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/medium"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
        />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/medium"
          icon={<MagnifyingGlassIcon className="size-4" />}
        />
        <ClipboardField value="with iconButton" variant="primary/medium" iconButton />
        <ClipboardField value="with iconButton" variant="secondary/medium" iconButton />
        <ClipboardField value="with iconButton" variant="tertiary/medium" iconButton />
      </div>
      <div className="flex flex-col items-start gap-y-8">
        <Header2>Secure value</Header2>
        <ClipboardField value="copy paste me" variant="primary/small" secure={true} />
        <ClipboardField value="copy paste me" variant="secondary/small" secure={true} />
        <ClipboardField value="copy paste me" variant="tertiary/small" secure={true} />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/small"
          secure={true}
          icon={<EnvironmentLabel environment={{ type: "STAGING" }} />}
        />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/small"
          icon={<MagnifyingGlassIcon className="size-4" />}
          secure={true}
        />
        <ClipboardField value="with iconButton" variant="primary/small" iconButton secure={true} />
        <ClipboardField
          value="with iconButton"
          variant="secondary/small"
          iconButton
          secure={true}
        />
        <ClipboardField value="with iconButton" variant="tertiary/small" iconButton secure={true} />
        {/* Medium size */}
        <ClipboardField value="copy paste me" variant="primary/medium" secure={true} />
        <ClipboardField value="copy paste me" variant="secondary/medium" secure={true} />
        <ClipboardField value="copy paste me" variant="tertiary/medium" secure={true} />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/medium"
          icon={<EnvironmentLabel environment={{ type: "STAGING" }} />}
          secure={true}
        />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/medium"
          icon={<MagnifyingGlassIcon className="size-4" />}
          secure={true}
        />
        <ClipboardField value="with iconButton" variant="primary/medium" iconButton secure={true} />
        <ClipboardField
          value="with iconButton"
          variant="secondary/medium"
          iconButton
          secure={true}
        />
        <ClipboardField
          value="with iconButton"
          variant="tertiary/medium"
          iconButton
          secure={true}
        />
      </div>
      <div className="flex flex-col items-start gap-y-8">
        <Header2>Custom secure value</Header2>
        <ClipboardField value="npx abcdefghi" variant="primary/small" secure="npx ••••••••" />
        <ClipboardField value="npx abcdefghi" variant="secondary/small" secure="npx ••••••••" />
        <ClipboardField value="npx abcdefghi" variant="tertiary/small" secure="npx ••••••••" />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/small"
          icon={<EnvironmentLabel environment={{ type: "PRODUCTION" }} />}
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/small"
          icon={<MagnifyingGlassIcon className="size-4" />}
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="primary/small"
          iconButton
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="secondary/small"
          iconButton
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/small"
          iconButton
          secure="npx ••••••••"
        />
        {/* Medium size */}
        <ClipboardField value="npx abcdefghi" variant="primary/medium" secure="npx ••••••••" />
        <ClipboardField value="npx abcdefghi" variant="secondary/medium" secure="npx ••••••••" />
        <ClipboardField value="npx abcdefghi" variant="tertiary/medium" secure="npx ••••••••" />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/medium"
          icon={<EnvironmentLabel environment={{ type: "PRODUCTION" }} />}
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/medium"
          icon={<MagnifyingGlassIcon className="size-4" />}
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="primary/medium"
          iconButton
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="secondary/medium"
          iconButton
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/medium"
          iconButton
          secure="npx ••••••••"
        />
      </div>
    </div>
  );
}
