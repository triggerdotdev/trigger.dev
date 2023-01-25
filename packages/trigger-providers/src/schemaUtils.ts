import { z } from "zod";
import { CamelCasedPropertiesDeep, SnakeCasedPropertiesDeep } from "type-fest";

/** Converts a Zod Schema from snake_case to camelCase */
export function snakeToCamel<O extends any, T extends z.ZodTypeDef, I>(
  schema: z.ZodType<O, T, I>
) {
  return schema.transform(
    (object) =>
      deepSnakeToCamel(object) as unknown as CamelCasedPropertiesDeep<
        typeof object
      >
  );
}

/** Converts a Zod Schema from camelCase to snake_case  */
export function camelToSnake<O extends any, T extends z.ZodTypeDef, I>(
  schema: z.ZodType<O, T, I>
) {
  return schema.transform(
    (object) =>
      deepCamelToSnake(object) as unknown as SnakeCasedPropertiesDeep<
        typeof object
      >
  );
}

function deepSnakeToCamel<T>(o: any): T {
  if (isObject(o)) {
    const n = {};

    Object.keys(o).forEach((k) => {
      // @ts-ignore
      n[keySnakeToCamel(k)] = deepSnakeToCamel(o[k]);
    });

    return n as T;
  } else if (isArray(o)) {
    return o.map((i: any) => {
      return deepSnakeToCamel(i);
    });
  }

  return o;
}

function keySnakeToCamel(s: string): string {
  return s.replace(/([_][a-z])/gi, ($1) => {
    return $1.toUpperCase().replace("-", "").replace("_", "");
  });
}

function deepCamelToSnake<T>(o: any): T {
  if (isObject(o)) {
    const n = {};

    Object.keys(o).forEach((k) => {
      // @ts-ignore
      n[keyCamelToSnake(k)] = deepCamelToSnake(o[k]);
    });

    return n as T;
  } else if (isArray(o)) {
    return o.map((i: any) => {
      return deepCamelToSnake(i);
    });
  }

  return o;
}

function keyCamelToSnake(s: string): string {
  return s
    .replace(/[\w]([A-Z])/g, function (m) {
      return m[0] + "_" + m[1];
    })
    .toLowerCase();
}

function isArray(a: any): boolean {
  return Array.isArray(a);
}

function isObject(o: any): boolean {
  return o === Object(o) && !isArray(o) && typeof o !== "function";
}
