import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";

export default function Story() {
  return (
    <div className="flex gap-8">
      <div className="flex flex-col items-start gap-y-[2.58rem] whitespace-nowrap p-8">
        <Header2>Clipboards</Header2>
        <Paragraph variant="small">primary/small</Paragraph>
        <Paragraph variant="small">secondary/small</Paragraph>
        <Paragraph variant="small">tertiary/small</Paragraph>
        <Paragraph variant="small">tertiary/small + LeadingIcon</Paragraph>
        <Paragraph variant="small">tertiary/small + LeadingIcon</Paragraph>
        <Paragraph variant="small">primary/medium</Paragraph>
        <Paragraph variant="small">secondary/medium</Paragraph>
        <Paragraph variant="small">tertiary/medium</Paragraph>
        <Paragraph variant="small">tertiary/medium + LeadingIcon</Paragraph>
        <Paragraph variant="small">tertiary/medium + LeadingIcon</Paragraph>
      </div>
      <div className="flex flex-col items-start gap-y-8 p-8">
        <Header2>Default</Header2>
        <ClipboardField value="copy paste me" variant="primary/small" />
        <ClipboardField value="copy paste me" variant="secondary/small" />
        <ClipboardField value="copy paste me" variant="tertiary/small" />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/small"
          icon={<EnvironmentLabel environment={{ type: "PRODUCTION" }} />}
        />
        <ClipboardField value="with leadingIcon" variant="tertiary/small" icon="search" />
        <ClipboardField value="copy paste me" variant="primary/medium" />
        <ClipboardField value="copy paste me" variant="secondary/medium" />
        <ClipboardField value="copy paste me" variant="tertiary/medium" />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/medium"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
        />
        <ClipboardField value="with leadingIcon" variant="tertiary/medium" icon="search" />
      </div>
      <div className="flex flex-col items-start gap-y-8 p-8">
        <Header2>Secure value</Header2>
        <ClipboardField value="copy paste me" variant="primary/small" secure={true} />
        <ClipboardField value="copy paste me" variant="secondary/small" secure={true} />
        <ClipboardField value="copy paste me" variant="tertiary/small" secure={true} />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/small"
          icon={<EnvironmentLabel environment={{ type: "STAGING" }} />}
          secure={true}
        />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/small"
          icon="search"
          secure={true}
        />
        <ClipboardField value="copy paste me" variant="primary/medium" secure={true} />
        <ClipboardField value="copy paste me" variant="secondary/medium" secure={true} />
        <ClipboardField value="copy paste me" variant="tertiary/medium" secure={true} />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/medium"
          icon={<EnvironmentLabel environment={{ type: "PRODUCTION" }} />}
          secure={true}
        />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/medium"
          icon="search"
          secure={true}
        />
      </div>
      <div className="flex flex-col items-start gap-y-8 p-8">
        <Header2>Custom secure value</Header2>
        <ClipboardField value="npx abcdefghi" variant="primary/small" secure="npx ••••••••" />
        <ClipboardField value="npx abcdefghi" variant="secondary/small" secure="npx ••••••••" />
        <ClipboardField value="npx abcdefghi" variant="tertiary/small" secure="npx ••••••••" />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/small"
          icon={<EnvironmentLabel environment={{ type: "STAGING" }} />}
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/small"
          icon="search"
          secure="npx ••••••••"
        />
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
          icon="search"
          secure="npx ••••••••"
        />
      </div>
    </div>
  );
}
