import { useCallback, useEffect, useRef } from 'react';
import { api, toGraphPayload } from '../lib/api';
import { useGraphStore } from '../store/graphStore';

const DEBOUNCE_MS = 800;

/** Debounced graph persistence (spec §18.3). Returns a function that saves immediately. */
export function useAutosave() {
  const timer = useRef<number | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const save = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    // Serialise saves so an older payload can never land after a newer one.
    while (inFlight.current) await inFlight.current;

    const s = useGraphStore.getState();
    if (!s.projectId || s.saveStatus === 'saved') return;
    const revision = s.revision;
    const projectId = s.projectId;
    s.setSaveStatus('saving');

    const run = api
      .updateProject(projectId, { graph: toGraphPayload(s.nodes, s.edges, s.viewport) })
      .then(() => {
        const now = useGraphStore.getState();
        if (now.projectId !== projectId) return;
        // Changes made while saving keep the state dirty so the next debounce picks them up.
        now.setSaveStatus(now.revision === revision ? 'saved' : 'dirty');
      })
      .catch((err: Error) => {
        useGraphStore.getState().setSaveStatus('error', err.message);
      })
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = run;
    await run;
  }, []);

  useEffect(
    () =>
      useGraphStore.subscribe((state, prev) => {
        if (state.revision === prev.revision || state.projectId !== prev.projectId) return;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void save(), DEBOUNCE_MS);
      }),
    [save],
  );

  // Flush pending edits when the tab is hidden or closed.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') void save();
    };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [save]);

  return save;
}
