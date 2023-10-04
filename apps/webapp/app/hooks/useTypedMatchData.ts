import { UIMatch, useMatches } from "@remix-run/react";
import { RemixSerializedType, UseDataFunctionReturn, deserializeRemix } from "remix-typedjson";
import { Handle } from "~/utils/handle";
import { AppData } from "~/utils/appData";

function useTypedDataFromMatches<T = AppData>({
  id,
  matches,
}: {
  id: string;
  matches: UIMatch<T, Handle>[];
}): UseDataFunctionReturn<T> | undefined {
  const match = matches.find((m) => m.id === id);
  return useTypedMatchData<T>(match);
}

export function useTypedMatchesData<T = AppData>({
  id,
  matches,
}: {
  id: string;
  matches?: UIMatch<T, Handle>[];
}): UseDataFunctionReturn<T> | undefined {
  if (!matches) {
    matches = useMatches() as UIMatch<T, Handle>[];
  }

  return useTypedDataFromMatches<T>({ id, matches });
}

export function useTypedMatchData<T = AppData>(
  match: UIMatch<T, Handle> | undefined
): UseDataFunctionReturn<T> | undefined {
  if (!match) {
    return undefined;
  }
  return deserializeRemix<T>(match.data as RemixSerializedType<T>) as
    | UseDataFunctionReturn<T>
    | undefined;
}
