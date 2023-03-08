import pointer from "json-pointer";

type Action = ({
  ref,
  object,
  key,
  definition,
  seenBefore,
  setRef,
}: {
  ref: string;
  object: any;
  key: string;
  definition: any;
  seenBefore: boolean;
  setRef: (newRef: string) => void;
}) => void;

export class SchemaRefWalker {
  spec: any;
  stack: { key: string; object: any }[];
  refsExplored: Map<string, any>;

  constructor(spec: any) {
    this.spec = spec;
    this.stack = [];
    this.refsExplored = new Map();
  }

  run(object: any, action: Action) {
    this.stack.push({ key: "root", object });
    this.#walk(action);
  }

  #walk(action: Action) {
    while (this.stack.length > 0) {
      const item = this.stack.pop();
      if (item === undefined) continue;

      const { key, object } = item;
      if (object == null) continue;
      if (typeof object !== "object") continue;

      if (object.$ref) {
        const path = (object.$ref as string).replace("#", "");

        if (!this.refsExplored.has(path)) {
          const ptr = pointer.get(this.spec, path);
          if (ptr === undefined) {
            throw new Error(`Invalid reference: ${object.$ref}`);
          }

          action({
            ref: object.$ref,
            object,
            key,
            definition: ptr,
            seenBefore: false,
            setRef: (newRef) => {
              object.$ref = newRef;
            },
          });

          this.refsExplored.set(path, ptr);

          this.stack.push({ key, object: ptr });
        } else {
          const ptr = this.refsExplored.get(path);
          action({
            ref: object.$ref,
            object,
            key,
            definition: ptr,
            seenBefore: true,
            setRef: (newRef) => {
              object.$ref = newRef;
            },
          });
        }
      }

      Object.entries(object).forEach(([key, value]) => {
        if (key === "$ref") {
          return;
        }

        if (typeof value === "object") {
          if (Array.isArray(value)) {
            value.forEach((item: any, index: number) => {
              this.stack.push({ key: index.toString(), object: item });
            });
          } else {
            this.stack.push({ key, object: value });
          }
        }
      });
    }
  }
}
