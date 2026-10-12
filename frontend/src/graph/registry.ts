import { nanoid } from 'nanoid';
import type { NodeDataByKind, NodeKind, PortType } from './types';

export interface InputPort {
  id: string;
  label: string;
  accepts: PortType[];
  multiple: boolean;
}

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
  prompt: {
    kind: 'prompt',
    label: 'Prompt',
    description: 'Text describing what to create or change',
    color: '#4c8df6',
    inputs: [],
    outputs: [{ id: OUT, label: 'Prompt', type: 'prompt' }],
    defaultData: () => ({ ...base('Prompt'), text: '', constraints: '', enabled: true, role: 'main', order: 0 }),
  },
  image: {
    kind: 'image',
    label: 'Reference Image',
    description: 'General visual reference',
    color: '#9a948c',
    inputs: [],
    outputs: [{ id: OUT, label: 'Image', type: 'image' }],
    defaultData: () => ({ ...base('Reference Image'), assetId: null, notes: '' }),
  },
  original: {
    kind: 'original',
    label: 'Original Image',
    description: 'The subject to transform or edit',
    color: '#ff7a00',
    inputs: [],
    outputs: [{ id: OUT, label: 'Original', type: 'original' }],
    defaultData: () => ({
      ...base('Original Image'),
      assetId: null,
      notes: '',
      instructions: '',
      preserve: {
        composition: false,
        shape: true,
        proportions: true,
        silhouette: true,
        mainSubject: true,
        objectCount: false,
      },
    }),
  },
  theme: {
    kind: 'theme',
    label: 'Theme Image',
    description: 'Art-style reference shared across assets',
    color: '#9b6bdf',
    inputs: [],
    outputs: [{ id: OUT, label: 'Theme', type: 'theme' }],
    defaultData: () => ({ ...base('Theme Image'), assetId: null, notes: '', roles: ['artStyle'] }),
  },
  palette: {
    kind: 'palette',
    label: 'Color Palette',
    description: 'Colours turned into prompt instructions',
    color: '#ee979b',
    inputs: [],
    outputs: [{ id: OUT, label: 'Palette', type: 'palette' }],
    defaultData: () => ({
      ...base('Color Palette'),
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
    inputs: [{ id: 'in', label: 'Generated', accepts: ['generated'], multiple: false }],
    outputs: [{ id: OUT, label: 'Assets', type: 'assetList' }],
    defaultData: () => ({
      ...base('Asset Collection'),
      role: 'input',
      description: '',
      items: [],
    }),
  },
  generate: {
    kind: 'generate',
    label: 'Generate',
    description: 'Combines inputs and calls the AI provider',
    color: '#3dbe6b',
    inputs: [
      { id: 'prompt', label: 'Prompt', accepts: ['prompt'], multiple: true },
      { id: 'original', label: 'Original', accepts: ['original', 'assetList'], multiple: true },
      { id: 'reference', label: 'Reference', accepts: ['image'], multiple: true },
      { id: 'theme', label: 'Theme', accepts: ['theme'], multiple: true },
      { id: 'palette', label: 'Palette', accepts: ['palette'], multiple: false },
    ],
    outputs: [{ id: OUT, label: 'Generated', type: 'generated' }],
    defaultData: () => ({
      ...base('Generate'),
      providerId: 'codex',
      model: '',
      mode: 'manual',
      outputCount: 1,
      variantsPerInput: 1,
      aspectRatio: '1:1',
      quality: 'auto',
      outputFormat: 'png',
      background: 'white',
      backgroundValue: '',
      assetCategory: 'Item',
      artStyle: '',
      preserveSubject: true,
      preserveSilhouette: true,
      consistentFraming: true,
      consistentScale: true,
      primaryOriginalNodeId: null,
    }),
  },
  output: {
    kind: 'output',
    label: 'Output Image',
    description: 'A single generated result',
    color: '#b8b0a6',
    inputs: [{ id: 'in', label: 'Generated', accepts: ['generated'], multiple: false }],
    outputs: [{ id: OUT, label: 'Image', type: 'image' }],
    defaultData: () => ({ ...base('Output Image'), assetId: null, generationId: null }),
  },
};

export const NODE_KINDS = Object.keys(definitions) as NodeKind[];

/** Kinds offered in the sidebar and add menu. Output Image nodes are created by generation, not by hand. */
export const ADDABLE_KINDS = NODE_KINDS.filter((k) => k !== 'output');

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
