import { calculateResetAt } from "@trigger.dev/core";
import { ObjectEntries } from "./types";

export const calculateResetAtUtil = calculateResetAt;

export const entries = <T extends object>(object: T): ObjectEntries<T> => {
  return Object.entries(object) as ObjectEntries<T>;
};

// see: https://github.com/sindresorhus/ts-extras
export const fromEntries = Object.fromEntries as <
  Key extends PropertyKey,
  Entries extends ReadonlyArray<readonly [Key, unknown]>,
>(
  values: Entries
) => {
  [K in Extract<Entries[number], readonly [Key, unknown]>[0]]: Extract<
    Entries[number],
    readonly [K, unknown]
  >[1];
};

export function titleCase(original: string): string {
  return original
    .split(" ")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
