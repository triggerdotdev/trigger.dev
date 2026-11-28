import type { MDXContent } from "mdx/types";
import { DocsBody } from "fumadocs-ui/layouts/notebook/page";
import { APIPage } from "@/components/api-page-lazy";
import { RequiredAccess } from "@/components/required-access";
import { getMDXComponents } from "@/components/mdx";
import type { PageApi } from "@/lib/source";

/** A page's body: the API reference and playground on API pages, then the MDX. */
export function PageBody({ MDX, api }: { MDX: MDXContent; api: PageApi | undefined }) {
  return (
    <DocsBody>
      {api && (
        <>
          <RequiredAccess access={api.access} pat={api.pat} />
          <APIPage
            document={api.document}
            operations={[{ path: api.path, method: api.method as "get" }]}
            showDescription={api.showDescription}
            access={api.access}
            preloaded={{ docs: { [api.document]: api.schema } }}
          />
        </>
      )}
      <MDX components={getMDXComponents()} />
    </DocsBody>
  );
}
