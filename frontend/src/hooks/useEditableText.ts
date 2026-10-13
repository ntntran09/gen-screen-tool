import { useState } from 'react';

/**
 * A text field inside a canvas node gets its `value` one render later than the typing event (React Flow
 * hands node data over through its own store). A controlled <textarea> that is briefly given the stale
 * value rewrites its text, which throws the caret to the end. The field therefore keeps what the user
 * typed locally and only follows the incoming value when it is a real outside change (undo, a collaborator).
 */
export interface EditableText {
  local: string;
  /** The last incoming value that was looked at. */
  seen: string;
  /** Values typed here that the store has not handed back yet, oldest first. */
  pending: string[];
}

export const startText = (value: string): EditableText => ({ local: value, seen: value, pending: [] });

export const typeText = (state: EditableText, value: string): EditableText => ({
  ...state,
  local: value,
  pending: [...state.pending, value],
});

/** Fold a new incoming value into the state; returns the same object when nothing changes. */
export function reconcileText(state: EditableText, incoming: string): EditableText {
  if (incoming === state.seen) return state;
  const echo = state.pending.indexOf(incoming);
  // Our own text coming back (possibly after more typing): keep what is on screen.
  if (echo >= 0) return { local: state.local, seen: incoming, pending: state.pending.slice(echo + 1) };
  return startText(incoming);
}

export function useEditableText(value: string, onChange: (value: string) => void): [string, (value: string) => void] {
  const [state, setState] = useState(() => startText(value));
  const next = reconcileText(state, value);
  if (next !== state) setState(next); // adjusting state while rendering is the supported way to follow a prop
  return [
    next.local,
    (typed) => {
      setState((current) => typeText(current, typed));
      onChange(typed);
    },
  ];
}
