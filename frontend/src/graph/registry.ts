import { nanoid } from 'nanoid';
import type { NodeDataByKind, NodeKind, PortType } from './types';

export interface InputPort {
  id: string;
  label: string;
  accepts: PortType[];
  multiple: boolean;
  /** Colour of the handle when it differs from the first accepted type. */
  color?: PortType;
  /** Must be connected for the node to run. */
  required?: boolean;
}

export const isPortRequired = (port: InputPort) => Boolean(port.required);

export interface OutputPort {
  id: string;
  label: string;
  type: PortType;
}

export interface NodeDefinition<K extends NodeKind = NodeKind> {
  kind: K;
  label: string;
  description: string;
  /** Header accent colour (spec §3.2). */
  color: string;
  inputs: InputPort[];
  outputs: OutputPort[];
  defaultData: () => NodeDataByKind[K];
}

const base = (title: string) => ({ title, collapsed: false, locked: false });

export const OUT = 'out';

const definitions: { [K in NodeKind]: NodeDefinition<K> } = {
  text: { kind: 'text', label: 'Text', description: 'Canvas text', color: '#5a544d', inputs: [], outputs: [],
    defaultData: () => ({ ...base('Text'), text: '', color: '#1a1a1a', fontSize: 13, comment: false }) },
  drawing: { kind: 'drawing', label: 'Drawing', description: 'Freehand stroke', color: '#5a544d', inputs: [], outputs: [],
    defaultData: () => ({ ...base('Drawing'), points: [], color: '#1a1a1a', strokeWidth: 3, canvasWidth: 1, canvasHeight: 1 }) },
  prompt: {
    kind: 'prompt',
    label: 'Prompt',
    description: 'Text describing what to create or change',
    color: '#4c8df6',
    inputs: [],
    outputs: [{ id: OUT, label: 'Prompt', type: 'prompt' }],
    defaultData: () => ({ ...base('Prompt'), text: '', enabled: true }),
  },
  image: {
    kind: 'image',
    label: 'Image',
    description: 'An image; used as Original, Theme or Reference depending on the port it connects to',
    color: '#ff7a00',
    inputs: [],
    outputs: [{ id: OUT, label: 'Image', type: 'image' }],
    defaultData: () => ({
      ...base('Image'),
      assetId: null,
      notes: '',
      roles: ['artStyle'],
    }),
  },
  palette: {
    kind: 'palette',
    label: 'Color Palette',
    description: 'Colours turned into prompt instructions; can take them from a connected image',
    color: '#ee979b',
    inputs: [{ id: 'image', label: 'Image', accepts: ['image'], multiple: false }],
    outputs: [{ id: OUT, label: 'Palette', type: 'palette' }],
    defaultData: () => ({
      ...base('Color Palette'),
      extractCount: 5,
      colors: [
        { id: nanoid(8), hex: '#F26B6B', role: 'primary', ratio: null },
        { id: nanoid(8), hex: '#FFC93C', role: 'secondary', ratio: null },
        { id: nanoid(8), hex: '#4CAF3A', role: 'accent', ratio: null },
      ],
    }),
  },
  collection: {
    kind: 'collection',
    label: 'Asset Collection',
    description: 'Many images behind one connection',
    color: '#2bb3a3',
    inputs: [
      { id: 'in', label: 'Generated', accepts: ['generated'], multiple: false },
      { id: 'extract', label: 'Cropped assets', accepts: ['extracted'], multiple: false },
    ],
    outputs: [{ id: OUT, label: 'Assets', type: 'assetList' }],
    defaultData: () => ({
      ...base('Asset Collection'),
      role: 'input',
      description: '',
      items: [],
      batchIds: [],
      syncedTaskIds: [],
    }),
  },
  extract: {
    kind: 'extract',
    label: 'Extract Assets',
    description: 'Finds the separate assets in an image with AI, then crops them into a collection for background removal',
    color: '#c9a227',
    inputs: [{ id: 'image', label: 'Image', accepts: ['image'], multiple: false, required: true }],
    outputs: [{ id: OUT, label: 'Assets', type: 'extracted' }],
    defaultData: () => ({ ...base('Extract Assets'), hint: '', detections: null, off: [], generateNodeId: null, collectionNodeId: null }),
  },
  generate: {
    kind: 'generate',
    label: 'Generate',
    description: 'Combines inputs and calls the AI provider',
    color: '#3dbe6b',
    inputs: [
      { id: 'prompt', label: 'Prompt', accepts: ['prompt'], multiple: true, required: true },
      {
        id: 'original',
        label: 'Original',
        accepts: ['image', 'assetList'],
        multiple: true,
        color: 'original',
        required: true,
      },
      { id: 'reference', label: 'Reference', accepts: ['image'], multiple: true },
      { id: 'theme', label: 'Theme', accepts: ['image'], multiple: true, color: 'theme' },
      { id: 'palette', label: 'Palette', accepts: ['palette'], multiple: false },
    ],
    outputs: [{ id: OUT, label: 'Generated', type: 'generated' }],
    defaultData: () => ({
      ...base('Generate'),
      providerId: 'codex',
      model: '',
      preset: 'screen',
      assetSelection: '',
      mode: 'manual',
      outputCount: 1,
      variantsPerInput: 1,
      aspectRatio: 'match',
      quality: 'auto',
      outputFormat: 'png',
      primaryOriginalNodeId: null,
    }),
  },
  output: {
    kind: 'output',
    label: 'Output Image',
    description: 'A single generated result',
    color: '#b8b0a6',
    inputs: [
      { id: 'in', label: 'Generated', accepts: ['generated'], multiple: false },
      { id: 'edit', label: 'Source', accepts: ['image', 'assetList'], multiple: false },
    ],
    outputs: [{ id: OUT, label: 'Image', type: 'image' }],
    defaultData: () => ({ ...base('Output Image'), assetId: null, generationId: null, taskId: null }),
  },
};

export const NODE_KINDS = Object.keys(definitions) as NodeKind[];

/** Kinds offered in the sidebar and add menu. Output Image nodes are created by generation, not by hand. */
export const ADDABLE_KINDS = NODE_KINDS.filter((k) => !['output', 'text', 'drawing'].includes(k));

export function getDefinition<K extends NodeKind>(kind: K): NodeDefinition<K> {
  return definitions[kind];
}

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === 'string' && value in definitions;
}

/** Output port type, taking per-instance state into account. */
export function outputType(kind: NodeKind, handleId: string | null | undefined): PortType | null {
  const port = definitions[kind].outputs.find((p) => p.id === (handleId ?? OUT));
  return port?.type ?? null;
}

export function inputPort(kind: NodeKind, handleId: string | null | undefined): InputPort | null {
  return definitions[kind].inputs.find((p) => p.id === handleId) ?? null;
}

export const LIMITS = {
  maxOutputCount: 200,
  maxVariantsPerInput: 5,
} as const;
