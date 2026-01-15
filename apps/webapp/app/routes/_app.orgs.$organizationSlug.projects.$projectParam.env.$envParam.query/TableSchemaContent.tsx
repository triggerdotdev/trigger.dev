import type { ColumnSchema } from "@internal/tsql";
import { Badge } from "~/components/primitives/Badge";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { querySchemas } from "~/v3/querySchemas";

function ColumnHelpItem({ col }: { col: ColumnSchema }) {
  return (
    <div className="pt-1">
      <div className="flex items-center gap-2">
        <CopyableText value={col.name} className="text-sm text-indigo-400" />
        <Badge className="font-mono text-xxs">{col.type}</Badge>
      </div>
      {col.description && (
        <Paragraph variant="extra-small" className="mt-1 text-text-dimmed">
          {col.description}
        </Paragraph>
      )}
      {col.example && (
        <div className="mt-1 flex items-baseline gap-0.5">
          <span className="text-xs text-text-dimmed">Example:</span>
          <CopyableText
            value={col.example}
            className="rounded-sm bg-charcoal-750 px-1.5 py-0.5 font-mono text-xxs"
          />
        </div>
      )}
      {col.allowedValues && col.allowedValues.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-1">
          <span className="text-xs text-text-dimmed">Available options:</span>
          {col.allowedValues.map((value) => (
            <CopyableText
              key={value}
              value={col.valueMap?.[value] ?? value}
              className="rounded-sm bg-charcoal-750 px-1.5 py-0.5 font-mono text-xxs"
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TableSchemaContent() {
  return (
    <div>
      {querySchemas.map((table) => (
        <div key={table.name} className="mb-6">
          <div className="mb-2">
            <Header3 className="font-mono text-text-bright">{table.name}</Header3>
            {table.description && (
              <Paragraph variant="small" className="mt-1 text-text-dimmed">
                {table.description}
              </Paragraph>
            )}
          </div>
          <div className="flex flex-col gap-2 divide-y divide-grid-dimmed">
            {Object.values(table.columns).map((col) => (
              <ColumnHelpItem key={col.name} col={col} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

