import { useState } from 'react';
import { NodeResizeControl, ResizeControlVariant, type NodeProps } from '@xyflow/react';
import type { CanvasNode, NodeDataByKind } from '../graph/types';
import { drawingPath } from '../graph/drawing';
import { useEditableText } from '../hooks/useEditableText';
import { useGraphStore } from '../store/graphStore';

export function TextNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const d = data as NodeDataByKind['text'];
  const [editing, setEditing] = useState(!d.text);
  const [text, setText] = useEditableText(d.text, (value) => useGraphStore.getState().updateNodeData(id, { text: value }));
  const width = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.width);
  const lineHeight = d.comment ? 1.5 : 1.35;
  const style = { color: d.color, fontSize: d.fontSize, lineHeight };
  const minHeight = d.comment ? Math.max(64, Math.ceil(d.fontSize * lineHeight) + 32) : Math.ceil(d.fontSize * lineHeight) + 8;
  return <>
    {!d.locked && (['left', 'right'] as const).map((position) => <NodeResizeControl key={position}
      position={position} variant={ResizeControlVariant.Line} resizeDirection="horizontal" minWidth={d.comment ? 144 : 80}
      style={{ width: 10, border: 'none', background: 'transparent', cursor: 'ew-resize', zIndex: 10 }}
      color="var(--color-focus)" onResizeStart={() => useGraphStore.getState().commit()} />)}
    <div role={d.comment ? 'note' : undefined} data-selected={selected || undefined}
      style={{ ...style, width: width ?? 240, minHeight }} onDoubleClick={() => !d.locked && setEditing(true)}
      className={`relative flex flex-col justify-center ${d.comment ? 'canvas-comment' : 'p-1'}`}>
    <div className="relative min-w-0">
      <div aria-hidden={editing && !d.locked ? true : undefined}
        className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${editing && !d.locked ? 'invisible' : ''}`}>
        {d.text || 'Text'}{d.text.endsWith('\n') ? '\u200b' : ''}
      </div>
      {editing && !d.locked && <textarea autoFocus rows={1} aria-label="Canvas text" placeholder="Text" value={text}
        wrap="soft" className="nodrag nopan nowheel absolute inset-0 block h-full min-h-0 w-full resize-none overflow-hidden whitespace-pre-wrap border-0 bg-transparent p-0 outline-none placeholder:text-inherit placeholder:opacity-100"
        style={{ ...style, overflowWrap: 'anywhere' }} onChange={(e) => setText(e.target.value)}
        onBlur={() => setEditing(false)} onKeyDown={(e) => {
          if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) { e.preventDefault(); setEditing(false); }
        }} />}
    </div>
    </div>
  </>;
}

export function DrawingNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const d = data as NodeDataByKind['drawing'];
  const path = drawingPath(d.points);
  return <svg width={d.canvasWidth} height={d.canvasHeight} role="img" aria-label="Drawing"
    className="overflow-visible">
    {selected && (d.points.length === 1 ?
      <circle cx={d.points[0].x} cy={d.points[0].y} r={d.strokeWidth / 2 + 2} fill="var(--color-focus)" opacity={0.4} pointerEvents="none" /> :
      <path d={path} fill="none" stroke="var(--color-focus)" strokeWidth={d.strokeWidth + 4} strokeLinecap="round" strokeLinejoin="round" opacity={0.4} pointerEvents="none" />)}
    {d.points.length === 1 ? <circle data-drawing-stroke={id} cx={d.points[0].x} cy={d.points[0].y} r={d.strokeWidth / 2} fill={d.color} /> :
      <path data-drawing-stroke={id} d={path} fill="none" stroke={d.color} strokeWidth={d.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />}
  </svg>;
}
