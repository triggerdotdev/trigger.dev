import type { UIMatch } from "@remix-run/react";
import { useMatches } from "@remix-run/react";
import type { RemixSerializedType, UseDataFunctionReturn } from "remix-typedjson";
import { deserializeRemix } from "remix-typedjson";

type AppData = any;

function useTypedDataFromMatches<T = AppData>({
  id,
  matches,
}: {
  id: string;
  matches: UIMatch[];
}): UseDataFunctionReturn<T> | undefined {
  const match = matches.find((m) => m.id === id);
  return useTypedMatchData<T>(match);
}

export function useTypedMatchesData<T = AppData>({
  id,
  matches,
}: {
  id: string;
  matches?: UIMatch[];
}): UseDataFunctionReturn<T> | undefined {
  const routeMatches = useMatches();

  return useTypedDataFromMatches<T>({ id, matches: matches ?? routeMatches });
}

function useTypedMatchData<T = AppData>(
  match: UIMatch | undefined
): UseDataFunctionReturn<T> | undefined {
  if (!match) {
    return undefined;
  }
  return deserializeRemix<T>(match.data as RemixSerializedType<T>) as
    | UseDataFunctionReturn<T>
    | undefined;
}
