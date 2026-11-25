import { Markdown } from "fumadocs-core/content/md";
import { sdkTypeRows } from "@/lib/sdk-type-table";
import { ResponseField } from "./mintlify";

/** The properties of an exported SDK type, read from the SDK's own types and JSDoc. */
export function SdkType({ name }: { name: string }) {
  const rows = sdkTypeRows(name);
  return (
    <div className="my-6" data-sdk-type={name}>
      {rows.map((row) => (
        <ResponseField
          key={row.name}
          name={row.name}
          type={row.type}
          required={row.required}
          deprecated={row.deprecated}
          default={row.default}
        >
          {row.description ? <Markdown>{row.description}</Markdown> : null}
        </ResponseField>
      ))}
    </div>
  );
}
