import { useReactFlow } from '@xyflow/react';
import { useEffect } from 'react';
import { useGraphStore } from '../store/graphStore';

/** True when the key event belongs to a text field and must not trigger canvas shortcuts (spec §3.3). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'color', 'range'].includes(type);
  }
  return false;
}

export function useShortcuts(saveNow: () => void) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Save works everywhere, including while typing.
      if (mod && key === 's') {
        e.preventDefault();
        saveNow();
        return;
      }
      if (isTypingTarget(e.target)) return;

      const s = useGraphStore.getState();
      // While a dialog (Collection Viewer, Lightbox) is open, only undo/redo reach the graph.
      const dialogOpen = document.querySelector('[aria-modal="true"]') !== null;
      const isUndoRedo = mod && (key === 'z' || key === 'y');
      if (dialogOpen && !isUndoRedo) return;

      if (mod && key === 'g' && !e.shiftKey) {
        e.preventDefault();
        s.groupIntoCollection();
      } else if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        s.undo();
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        s.redo();
      } else if (mod && key === 'c') {
        s.copySelected();
      } else if (mod && key === 'd') {
        e.preventDefault();
        s.duplicateSelected();
      } else if (mod && key === 'a') {
        e.preventDefault();
        s.selectAll();
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        s.deleteSelected();
      } else if (!mod && e.shiftKey && key === '1') {
        void fitView({ padding: 0.2, duration: 200 });
      } else if (!mod && e.shiftKey && key === '2') {
        const selected = s.nodes.filter((n) => n.selected);
        if (selected.length) void fitView({ nodes: selected, padding: 0.3, duration: 200 });
      } else if (!mod && !e.shiftKey && !e.altKey && (key === 'v' || key === 'h' || key === 'e')) {
        s.setTool(key === 'v' ? 'select' : key === 'h' ? 'pan' : 'eraser');
      } else if (!mod && e.key === 'Escape' && s.tool !== 'select') {
        s.setTool('select');
      } else if (!mod && (e.key === '+' || e.key === '=')) {
        void zoomIn({ duration: 150 });
      } else if (!mod && e.key === '-') {
        void zoomOut({ duration: 150 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitView, zoomIn, zoomOut, saveNow]);
}
