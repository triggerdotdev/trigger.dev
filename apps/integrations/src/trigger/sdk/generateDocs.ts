import { JSONSchema } from "core/schemas/types";
import { Service } from "core/service/types";
import { Project } from "ts-morph";
import { FunctionData } from "./types";
import {
  fileNameFromTitleCase,
  TitleCaseWithSpaces,
  toFriendlyTypeName,
} from "./utilities";

type DocsSchemaObject = {
  path: string;
  required: boolean;
  types: Set<string>;
  default?: string;
  description?: string;
  children?: DocsSchemaObject[];
  childrenCollectionName?: string;
  childrenExpanded?: boolean;
};

export async function generateDocs(
  project: Project,
  basePath: string,
  service: Service,
  functionsData: Record<string, FunctionData>
) {
  const promises = Object.values(functionsData).map(async (f) => {
    //for debugging you can generate save the FunctionData JSON
    // project.createSourceFile(
    //   `${basePath}/docs/${fileNameFromTitleCase(f.friendlyName)}.fdata.json`,
    //   JSON.stringify(f, null, 2),
    //   {
    //     overwrite: true,
    //   }
    // );

    //metadata and intro
    let markdown = generatePageMetadata(f.title, f.description);

    //Base params
    markdown += `
    
## Params
    
<ParamField path="key" type="string" required={true}>
  A unique string. Please see the [Keys and Resumability](/guides/resumability)
  doc for more info.
</ParamField>`;

    //Input schema
    if (f.input) {
      const inputDocsObject = generateDocSchema("params", true, f.input, true);

      if (inputDocsObject) {
        //for debugging you can save the DocObject JSON
        // project.createSourceFile(
        //   `${basePath}/docs/${fileNameFromTitleCase(
        //     f.friendlyName
        //   )}.docobj.json`,
        //   JSON.stringify(inputDocsObject, null, 2),
        //   {
        //     overwrite: true,
        //   }
        // );

        const inputMarkdown = generateMarkdownFromDocSchema(
          "ParamField",
          inputDocsObject
        );
        markdown += inputMarkdown;
      }
    }

    if (f.output) {
      const outputDocsObject = generateDocSchema("response", true, f.output);
      if (outputDocsObject) {
        const outputMarkdown = generateMarkdownFromDocSchema(
          "ResponseField",
          outputDocsObject
        );
        markdown += "\n\n## Response\n\n";
        markdown += outputMarkdown;
      }
    }

    project.createSourceFile(
      `${basePath}/docs/${fileNameFromTitleCase(f.friendlyName)}.mdx`,
      markdown,
      {
        overwrite: true,
      }
    );

    return Promise.resolve();
  });

  await Promise.all(promises);
  return;
}

function generatePageMetadata(title: string, description: string) {
  return `---
title: ${title}
sidebarTitle: ${title}
description: ${sanitizeText(description)}
---`;
}

function generateDocSchema(
  key: string,
  required: boolean,
  schema: JSONSchema | boolean,
  expanded = false
): DocsSchemaObject | undefined {
  if (typeof schema === "boolean") return;

  let description = createDescription(schema);

  if (schema.allOf) {
    const combinedSchema: JSONSchema = {
      type: "object",
      description,
      properties: schema.allOf.reduce((acc, v) => {
        if (typeof v === "boolean") return acc;
        return { ...acc, ...v.properties };
      }, {}),
      required: schema.allOf.reduce((acc: string[], v) => {
        if (typeof v === "boolean") return acc;
        return [...acc, ...(v.required ?? [])];
      }, []),
    };

    return generateDocSchema(key, required, combinedSchema, expanded);
  }

  if (schema.oneOf) {
    const oneOfTypes = schema.oneOf
      .map((v) => {
        if (typeof v === "boolean") return "";
        return v.type?.toString() ?? "";
      })
      .filter(Boolean);
    const children: DocsSchemaObject[] = [];

    children.push(
      ...schema.oneOf.flatMap((v) => {
        const doc = generateDocSchema(
          toFriendlyTypeName(v.title ?? "Value"),
          false,
          v
        );
        return doc ? [doc] : [];
      })
    );

    description +=
      "\n\n*Please note that this object is one of the following possible types*";

    return {
      path: key,
      required,
      types: new Set(oneOfTypes),
      description,
      children,
      childrenCollectionName: `possible types for ${key}`,
      childrenExpanded: expanded,
    };
  }

  if (schema.anyOf) {
    const anyOfTypes = schema.anyOf
      .map((v) => {
        if (typeof v === "boolean") return "";
        return v.type?.toString() ?? "";
      })
      .filter(Boolean);

    const children: DocsSchemaObject[] = [];

    children.push(
      ...schema.anyOf.flatMap((v) => {
        const doc = generateDocSchema(
          toFriendlyTypeName(v.title ?? "Value"),
          false,
          v
        );
        return doc ? [doc] : [];
      })
    );

    description +=
      "\n\n*Please note that this object is one of the following possible types*";

    return {
      path: key,
      required,
      types: new Set(anyOfTypes),
      description,
      children,
      childrenCollectionName: `possible types for ${key}`,
      childrenExpanded: expanded,
    };
  }

  if (
    schema.type === "object" &&
    (schema.properties || schema.additionalProperties)
  ) {
    const children: DocsSchemaObject[] = [];

    if (schema.properties) {
      children.push(
        ...Object.entries(schema.properties).flatMap(([k, v]) => {
          const doc = generateDocSchema(
            k,
            schema.required?.find((r) => r === k) != undefined ?? false,
            v
          );
          return doc ? [doc] : [];
        })
      );
    }
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties !== "boolean"
    ) {
      if (typeof schema.additionalProperties !== "boolean") {
        const doc = generateDocSchema(
          `${key}[key]`,
          false,
          schema.additionalProperties
        );
        if (doc) children.push(doc);
      }
    }

    return {
      path: key,
      required,
      types: new Set(["object"]),
      description,
      children: children.sort(
        (a, b) => Number(b.required) - Number(a.required)
      ),
      childrenCollectionName: "properties",
      childrenExpanded: expanded,
    };
  }

  if (schema.type === "array" && schema.items) {
    const doc = generateDocSchema(`${key}[n]`, required, schema.items);
    if (doc) {
      return {
        path: key,
        required,
        types: new Set(["array"]),
        description,
        children: [doc],
        childrenCollectionName: "items",
        childrenExpanded: expanded,
      };
    }
  }

  return {
    path: key,
    required,
    types: new Set([`${schema.type}` ?? ""]),
    description,
  };
}

function createDescription(schema: JSONSchema): string | undefined {
  const description = schema.description
    ? schema.description
    : TitleCaseWithSpaces(schema.title);

  if (!description) return;
  return sanitizeText(description);
}

//encode angle brackets for displaying in HTML
function sanitizeText(original: string): string {
  return original.replace(/</gm, "&lt;").replace(/>/gm, "&gt;");
}

function generateMarkdownFromDocSchema(
  fieldType: "ParamField" | "ResponseField",
  docSchema: DocsSchemaObject
): string {
  let markdown = `<${fieldType} path="${docSchema.path}" type="${Array.from(
    docSchema.types
  ).join(" | ")}" required={${docSchema.required}}>\n`;
  if (docSchema.description) {
    markdown += `   ${docSchema.description}\n`;
  }
  if (docSchema.children) {
    markdown += `<Expandable title="${
      docSchema.childrenCollectionName ?? "properties"
    }" defaultOpen={${docSchema.childrenExpanded ?? false}}>`;
    docSchema.children.forEach((child) => {
      markdown += generateMarkdownFromDocSchema(fieldType, child);
    });
    markdown += `</Expandable>`;
  }
  markdown += `</${fieldType}>`;
  return markdown;
}
