import { useRef, useState, type PointerEvent } from 'react';
import { useReactFlow, useViewport } from '@xyflow/react';
import { drawingPath, makeDrawing, stabilizePoint, type DrawPoint } from '../graph/drawing';
import { useGraphStore } from '../store/graphStore';

export function AnnotationLayer({ tool, color, width, comment, fontSize }: { tool: 'text' | 'draw'; color: string; width: number; comment: boolean; fontSize: number }) {
  const { screenToFlowPosition } = useReactFlow();
  const viewport = useViewport();
  const stroke = useRef<{ pointerId: number; points: DrawPoint[] } | null>(null);
  const [preview, setPreview] = useState<DrawPoint[]>([]);
  const point = (e: PointerEvent) => screenToFlowPosition({ x: e.clientX, y: e.clientY });
  const finish = (e: PointerEvent) => {
    const current = stroke.current;
    if (!current || current.pointerId !== e.pointerId) return;
    current.points.push(point(e));
    const drawing = makeDrawing(current.points, width);
    if (drawing) {
      const { position, ...data } = drawing;
      useGraphStore.getState().addNode('drawing', position, { ...data, color, strokeWidth: width });
    }
    stroke.current = null; setPreview([]);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return <div className="nodrag nopan absolute inset-0 z-[4] touch-none cursor-crosshair"
    aria-label={tool === 'draw' ? 'Draw on canvas' : 'Place text on canvas'}
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      if (tool === 'text') {
        useGraphStore.getState().addNode('text', point(e), { color, comment, fontSize });
        useGraphStore.getState().setTool('select');
        return;
      }
      const points = [point(e)];
      stroke.current = { pointerId: e.pointerId, points }; setPreview(points);
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={(e) => {
      const current = stroke.current;
      if (!current || current.pointerId !== e.pointerId || current.points.length >= 5000) return;
      const next = point(e), last = current.points[current.points.length - 1];
      if (Math.hypot(next.x - last.x, next.y - last.y) * viewport.zoom < 2) return;
      current.points.push(stabilizePoint(last, next, viewport.zoom)); setPreview([...current.points]);
    }}
    onPointerUp={finish}
    onPointerCancel={() => { stroke.current = null; setPreview([]); }}>
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
        <path d={drawingPath(preview)} stroke={color} strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  </div>;
}
