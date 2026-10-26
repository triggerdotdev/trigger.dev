import { useCallback, useEffect, useRef, useState } from "react";

export type CreationSessionDeps = {
  enabled: boolean;
  createSession: (signal: AbortSignal) => Promise<string | undefined>;
  discardSession: (chatId: string) => void;
  generation?: number;
};

export type CreationSession = {
  chatId: string | undefined;
  /** Creates the chat on first need; nothing is stored until then. */
  ensure: () => Promise<string | undefined>;
  /** Holds the chat until the returned release is called by this owner. */
  keep: () => () => void;
};

type Owners = { count: number; attached: boolean };

export function useCreationSession({
  enabled,
  createSession,
  discardSession,
  generation = 0,
}: CreationSessionDeps): CreationSession {
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const current = useRef<string | undefined>(undefined);
  const pending = useRef<Promise<string | undefined> | undefined>(undefined);
  const seq = useRef(0);
  const owners = useRef<Owners>({ count: 0, attached: true });
  const controller = useRef<AbortController | undefined>(undefined);
  const deps = useRef({ createSession, discardSession });
  // oxlint-disable-next-line react/refs -- Latest-value ref kept in sync during render on purpose.
  deps.current = { createSession, discardSession };

  useEffect(() => {
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- Cleanup intentionally reads the latest ref values.
      seq.current++;
      controller.current?.abort();
      controller.current = undefined;
      pending.current = undefined;
      if (current.current && owners.current.count === 0) {
        deps.current.discardSession(current.current);
      }
      current.current = undefined;
      owners.current.attached = false;
      owners.current = { count: 0, attached: true };
      setChatId(undefined);
    };
  }, [enabled, generation]);

  const ensure = useCallback(async () => {
    if (!enabled) return undefined;
    if (current.current) return current.current;
    if (pending.current) return pending.current;
    const mySeq = seq.current;
    const abort = new AbortController();
    controller.current = abort;
    pending.current = (async () => {
      let id: string | undefined;
      try {
        id = await deps.current.createSession(abort.signal);
      } catch {
        if (seq.current === mySeq) pending.current = undefined;
        return undefined;
      }
      if (!id) {
        if (seq.current === mySeq) pending.current = undefined;
        return undefined;
      }
      if (seq.current !== mySeq) {
        deps.current.discardSession(id);
        return undefined;
      }
      current.current = id;
      setChatId(id);
      return id;
    })();
    return pending.current;
  }, [enabled]);

  const keep = useCallback(() => {
    const held = owners.current;
    const id = current.current;
    held.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.count--;
      if (!held.attached && held.count === 0 && id) deps.current.discardSession(id);
    };
  }, []);

  return { chatId, ensure, keep };
}
