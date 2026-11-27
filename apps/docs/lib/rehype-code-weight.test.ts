import type { Element, Root } from "hast";
import { assert, test } from "vitest";
import { rehypeLazyHovers, rehypeTokenClasses } from "./rehype-code-weight.ts";
import { tokenStyles } from "./shiki-themes.ts";

const span = (style: string, text: string): Element => ({
  type: "element",
  tagName: "span",
  properties: { style },
  children: [{ type: "text", value: text }],
});
const el = (tagName: string, children: Element["children"]): Element => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

test("known token styles become classes, unknown ones stay inline", () => {
  const tree: Root = {
    type: "root",
    children: [span(tokenStyles[2]!, "const"), span("color:red", "x")],
  };
  rehypeTokenClasses()(tree);
  const [known, unknown] = tree.children as Element[];
  assert.deepEqual(known!.properties, { className: ["sk2"] });
  assert.equal(unknown!.properties.style, "color:red");
});

// Catches: popup HTML left in the page, or repeated hovers shipped once per occurrence.
test("popups become indexed TypeHovers with a deduplicated hovers export", () => {
  const popup = (doc: string) =>
    el("Popup", [
      el("PopupContent", [el("div", [{ type: "text", value: doc }])]),
      el("PopupTrigger", [{ type: "text", value: "task" }]),
    ]);
  const tree: Root = {
    type: "root",
    children: [el("code", [popup("const task"), popup("const task"), popup("logger")])],
  };
  rehypeLazyHovers()(tree);
  const hovers = (tree.children[0] as Element).children as Element[];
  assert.deepEqual(
    hovers.map((h) => [h.tagName, h.properties.hover]),
    [
      ["TypeHover", 0],
      ["TypeHover", 0],
      ["TypeHover", 1],
    ]
  );
  assert.deepEqual(hovers[0]!.children, [{ type: "text", value: "task" }]);
  const esm = tree.children[1] as unknown as {
    data: {
      estree: {
        body: { declaration: { declarations: { init: { elements: { value: string }[] } }[] } }[];
      };
    };
  };
  const values = esm.data.estree.body[0]!.declaration.declarations[0]!.init.elements.map(
    (e) => e.value
  );
  assert.deepEqual(values, ["<div>const task</div>", "<div>logger</div>"]);
});

// Catches: a snippet's hover indices resolving against the importing page's hovers (wrong types).
test("a snippet's popups keep their HTML inline", () => {
  const tree: Root = {
    type: "root",
    children: [
      el("Popup", [
        el("PopupContent", [el("div", [{ type: "text", value: "defineConfig" }])]),
        el("PopupTrigger", [{ type: "text", value: "defineConfig" }]),
      ]),
    ],
  };
  rehypeLazyHovers()(tree, { path: "/repo/docs/snippets/node-versions.mdx" } as never);
  assert.deepEqual(tree.children.length, 1);
  assert.deepEqual((tree.children[0] as Element).properties, { html: "<div>defineConfig</div>" });
});
