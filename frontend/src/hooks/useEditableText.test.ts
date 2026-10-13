import { describe, expect, it } from 'vitest';
import { reconcileText, startText, typeText } from './useEditableText';

describe('editable text', () => {
  it('keeps what was typed while the store still hands back the old value', () => {
    let s = startText('hello');
    s = typeText(s, 'helo'); // user deleted a letter
    expect(reconcileText(s, 'hello')).toBe(s); // stale value: nothing changes
    s = reconcileText(s, 'helo'); // the store caught up
    expect(s.local).toBe('helo');
    expect(s.pending).toEqual([]);
  });

  it('survives several quick edits arriving one by one', () => {
    let s = startText('abc');
    s = typeText(typeText(s, 'ab'), 'a');
    s = reconcileText(s, 'ab'); // an intermediate echo
    expect(s.local).toBe('a');
    s = reconcileText(s, 'a');
    expect(s).toMatchObject({ local: 'a', pending: [] });
  });

  it('follows a real outside change (undo or a collaborator)', () => {
    let s = typeText(startText('one'), 'one two');
    s = reconcileText(s, 'one two');
    s = reconcileText(s, 'something else');
    expect(s).toEqual(startText('something else'));
  });
});
