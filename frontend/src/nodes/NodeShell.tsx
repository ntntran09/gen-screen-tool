import { Handle, Position, useNodeConnections, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { memo, useEffect, type ReactNode } from 'react';
import { getDefinition, isPortRequired, type InputPort, type OutputPort } from '../graph/registry';
import type { CanvasNode, PortType } from '../graph/types';
import { NodeIcon } from '../components/NodeIcon';
import { GenerateSymbol } from '../components/InlineGenerationControl';
import { isNodeFrozen, useGraphStore } from '../store/graphStore';

const portColor = (type: PortType) => `var(--color-port-${type})`;

/** Hollow while unconnected; filled with the port's type colour once something is attached. */
function PortHandle({
  type,
  id,
  portType,
  title,
  symbol = false,
}: {
  type: 'source' | 'target';
  id: string;
  portType: PortType;
  title?: string;
  symbol?: boolean;
}) {
  const connected = useNodeConnections({ handleType: type, handleId: id }).length > 0;
  return (
    <Handle
      type={type}
      position={type === 'target' ? Position.Left : Position.Right}
      id={id}
      title={title}
      aria-label={title}
      className={symbol ? 'inline-generation-handle' : undefined}
      data-connected={connected || undefined}
      style={{ background: symbol ? `linear-gradient(135deg, color-mix(in srgb, ${getDefinition('prompt').color} 16%, white), color-mix(in srgb, ${getDefinition('generate').color} 16%, white))` : connected ? portColor(portType) : 'var(--color-node)' }}
    >
      {symbol && <GenerateSymbol />}
    </Handle>
  );
}

function useConnectionCount(type: 'source' | 'target', id: string) {
  return useNodeConnections({ handleType: type, handleId: id }).length;
}

function InputRow({ port, required }: { port: InputPort; required: boolean }) {
  const count = useConnectionCount('target', port.id);
  return (
    <div
      className={`relative flex h-6 items-center pl-3 text-[11px] ${
        count ? 'font-semibold text-ink' : required ? 'font-semibold text-danger' : 'text-ink-2'
      }`}
    >
      <PortHandle
        type="target"
        id={port.id}
        portType={port.color ?? port.accepts[0]}
        title={`${port.label}${required ? ', required' : ', optional'}${port.multiple ? ', several allowed' : ', one only'}`}
      />
      {port.label}
      {required && (
        <span
          className={`ml-0.5 text-[14px] font-bold leading-none ${count ? 'text-success' : 'text-danger'}`}
          title={count ? 'Required: connected' : 'Required: connect something here to run'}
          aria-label={count ? 'required, connected' : 'required, not connected'}
        >
          *
        </span>
      )}
      {port.multiple && <span className="ml-1 font-normal text-ink-3">{count > 1 ? `×${count}` : '+'}</span>}
    </div>
  );
}

function OutputRow({ port, symbol }: { port: OutputPort; symbol?: boolean }) {
  const count = useConnectionCount('source', port.id);
  return (
    <div className={`relative flex h-6 items-center justify-end ${symbol ? 'pr-5' : 'pr-3'} text-[11px] ${count ? 'font-semibold text-ink' : 'text-ink-2'}`}>
      {port.label}
      <PortHandle type="source" id={port.id} portType={port.type} symbol={symbol} title={symbol ? 'Prompt + Generate · edit in the inspector' : port.label} />
    </div>
  );
}

interface ShellProps {
  node: NodeProps<CanvasNode>;
  /** Hide specific input ports (e.g. an Input Collection has no Generated input). */
  hiddenInputs?: string[];
  badge?: ReactNode;
  children?: ReactNode;
  width?: number;
  outputSymbol?: boolean;
}

export const NodeShell = memo(function NodeShell({ node, hiddenInputs = [], badge, children, width = 240, outputSymbol }: ShellProps) {
  const def = getDefinition(node.type);
  const { title, collapsed, locked } = node.data;
  const frozen = useGraphStore((s) => s.frozenCount > 0 && isNodeFrozen(node.id));
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const inputs = def.inputs.filter((p) => !hiddenInputs.includes(p.id));
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => { updateInternals(node.id); }, [node.id, outputSymbol, updateInternals]);
  // Source-only nodes (prompt, images, palette, input collection) put their single
  // output handle on the header instead of spending a whole row on it.
  const headerOutput = inputs.length === 0 && def.outputs.length === 1 ? def.outputs[0] : null;
  const showPortRows = !headerOutput && (inputs.length > 0 || def.outputs.length > 0);
  const showBody = !collapsed && Boolean(children);


  return (
    <div
      className={`rounded-[14px] border-2 bg-node ${
        node.selected ? 'border-accent ring-4 ring-accent/20' : frozen ? 'border-accent' : 'border-outline'
      }`}
      title={frozen ? 'Frozen while generating' : undefined}
      style={{ width }}
    >
      <div
        className={`relative flex items-center gap-2 px-3 py-2 ${
          showPortRows || showBody ? 'rounded-t-[12px] border-b-2 border-outline' : 'rounded-[12px]'
        }`}
        style={{ background: `color-mix(in srgb, ${def.color} 16%, white)` }}
      >
        <NodeIcon kind={node.type} size={15} />
        <span className="min-w-0 flex-1 truncate font-semibold text-ink" title={title}>
          {title}
        </span>
        {badge}
        {frozen ? (
          <span className="text-[10px] uppercase tracking-wide text-accent" title="Frozen while generating">
            Generating
          </span>
        ) : (
          locked && (
            <span className="text-[10px] uppercase tracking-wide text-ink-3" title="Locked">
              Locked
            </span>
          )
        )}
        <button
          type="button"
          className="nodrag rounded px-1 text-ink-2 hover:bg-white/60 hover:text-ink disabled:opacity-40"
          disabled={frozen}
          onClick={() => updateNodeData(node.id, { collapsed: !collapsed })}
          aria-label={collapsed ? 'Expand node' : 'Collapse node'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        {headerOutput && (
          <PortHandle type="source" id={headerOutput.id} portType={headerOutput.type} title={headerOutput.label} />
        )}
      </div>

      {showPortRows && (
        <div className="flex justify-between py-1">
          <div>{inputs.map((p) => <InputRow key={p.id} port={p} required={isPortRequired(p)} />)}</div>
          <div>{def.outputs.map((p) => <OutputRow key={p.id} port={p} symbol={outputSymbol} />)}</div>
        </div>
      )}

      {showBody && (
        <div className={`px-3 py-2.5 ${showPortRows ? 'border-t-2 border-outline' : ''}`}>{children}</div>
      )}
    </div>
  );
});
