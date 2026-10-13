import { useEffect } from 'react';
import { flushProjectSync, startProjectSync } from '../lib/projectSync';

/** Optimistic property sync; await acknowledgement before switching/generating. */
export function useAutosave() {
  useEffect(startProjectSync, []);
  return flushProjectSync;
}
