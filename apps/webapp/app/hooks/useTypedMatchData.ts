import { RouteMatch, useMatches } from "@remix-run/react";
import { RemixSerializedType, UseDataFunctionReturn, deserializeRemix } from "remix-typedjson";

type AppData = any;

function useTypedDataFromMatches<T = AppData>({
  id,
  matches,
}: {
  id: string;
  matches: RouteMatch[];
}): UseDataFunctionReturn<T> | undefined {
  const match = matches.find((m) => m.id === id);
  return useTypedMatchData<T>(match);
}

export function useTypedMatchesData<T = AppData>({
  id,
  matches,
}: {
  id: string;
  matches?: RouteMatch[];
}): UseDataFunctionReturn<T> | undefined {
  if (!matches) {
    matches = useMatches();
  }

  return useTypedDataFromMatches<T>({ id, matches });
}

export function useTypedMatchData<T = AppData>(
  match: RouteMatch | undefined
): UseDataFunctionReturn<T> | undefined {
  if (!match) {
    return undefined;
  }
  return deserializeRemix<T>(match.data as RemixSerializedType<T>) as
    | UseDataFunctionReturn<T>
    | undefined;
}
