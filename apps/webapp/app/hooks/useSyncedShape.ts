import { useShape } from "@electric-sql/react";

export type ShapeInput = Parameters<typeof useShape>[0];
export type ShapeOutput<S> = {
  error: Error | false;
  isError: boolean;
  data: S[] | undefined;
};

export type SyncedShapeData<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
    ? string | null
    : T[K] extends BigInt
    ? number
    : T[K] extends BigInt | null
    ? number | null
    : T[K] extends object
    ? SyncedShapeData<T[K]>
    : T[K];
};

export function useSyncedShape<S>(props: ShapeInput): ShapeOutput<SyncedShapeData<S>> {
  const output = useShape(props) as any;

  return {
    error: output.error,
    isError: output.isError,
    data: output.data
      ? (transformInput(output.data as InputObject) as SyncedShapeData<S>[])
      : undefined,
  };
}

type InputObject = {
  [key: string]: Value;
}[];

type Value =
  | string
  | number
  | boolean
  | bigint
  | null
  | Value[]
  | {
      [key: string]: Value;
    };

function transformInput(input: InputObject): SyncedShapeData<Value> {
  return input.map((value) => transformValue(value));
}

function transformValue(value: Value): Value {
  if (Array.isArray(value)) {
    return value.map(transformValue);
  } else if (typeof value === "object" && value !== null) {
    const result: { [key: string]: Value } = {};

    for (const key in value) {
      result[key] = transformValue(value[key]);
    }

    return result;
  } else if (typeof value === "bigint") {
    return Number(value);
  } else {
    return value;
  }
}
