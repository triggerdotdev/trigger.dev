import { BookOpenIcon } from "@heroicons/react/20/solid";
import { CodeBlock } from "~/components/code/CodeBlock";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { docsPath } from "~/utils/pathBuilder";

export function SchemaTabContent({
  schema,
  inferredSchema,
  title = "Payload schema",
  description,
  showDocsLink = true,
}: {
  schema?: unknown;
  inferredSchema?: unknown;
  title?: string;
  description?: string;
  showDocsLink?: boolean;
}) {
  if (schema) {
    return (
      <div className="space-y-2">
        <Header3 className="text-text-bright">{title}</Header3>
        {showDocsLink ? (
          <Paragraph variant="extra-small" className="text-text-dimmed">
            {description ?? (
              <>
                JSON Schema defined by this task via{" "}
                <TextLink to={docsPath("tasks/schemaTask")}>schemaTask</TextLink>.
              </>
            )}
          </Paragraph>
        ) : description ? (
          <Paragraph variant="extra-small" className="text-text-dimmed">
            {description}
          </Paragraph>
        ) : null}
        <CodeBlock
          code={JSON.stringify(schema, null, 2)}
          language="json"
          showLineNumbers={false}
          showOpenInModal={false}
        />
      </div>
    );
  }

  if (inferredSchema) {
    return (
      <div className="space-y-3">
        <Header3 className="text-text-bright">Inferred schema</Header3>
        <Paragraph variant="extra-small" className="text-text-dimmed">
          Schema inferred from recent run payloads. For an exact schema, use schemaTask.
        </Paragraph>
        <LinkButton
          variant="docs/small"
          LeadingIcon={BookOpenIcon}
          to={docsPath("tasks/schemaTask")}
        >
          schemaTask docs
        </LinkButton>
        <CodeBlock
          code={JSON.stringify(inferredSchema, null, 2)}
          language="json"
          showLineNumbers={false}
          showOpenInModal={false}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Header3 className="text-text-bright">No schema defined</Header3>
      <Paragraph variant="small" className="text-text-dimmed">
        Use <code className="text-text-bright">schemaTask</code> to define a payload schema for this
        task. The schema will appear here and can be used by AI to generate example payloads.
      </Paragraph>
      <LinkButton variant="docs/small" LeadingIcon={BookOpenIcon} to={docsPath("tasks/schemaTask")}>
        schemaTask docs
      </LinkButton>
      <CodeBlock
        code={exampleCode}
        language="typescript"
        showLineNumbers={false}
        showCopyButton={false}
        showOpenInModal={false}
      />
    </div>
  );
}

const exampleCode = `import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

export const myTask = schemaTask({
  id: "my-task",
  schema: z.object({
    name: z.string(),
    email: z.string().email(),
    count: z.number().int().positive(),
  }),
  run: async (payload) => {
    // payload is fully typed
    console.log(payload.name);
  },
});`;
