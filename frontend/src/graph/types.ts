import type { Edge, Node } from '@xyflow/react';

export type NodeKind =
  | 'prompt'
  | 'image'
  | 'original'
  | 'theme'
  | 'palette'
  | 'collection'
  | 'generate'
  | 'output';

/** Value types that flow along edges (spec §25.1). */
export type PortType = 'prompt' | 'image' | 'original' | 'theme' | 'palette' | 'assetList' | 'generated';

export interface BaseNodeData {
  title: string;
  collapsed: boolean;
  locked: boolean;
  [key: string]: unknown;
}

export interface PromptData extends BaseNodeData {
  text: string;
  constraints: string;
  enabled: boolean;
  role: 'main' | 'style' | 'constraints' | 'output';
  order: number;
}

export interface ImageData extends BaseNodeData {
  /** Set once the asset system (Phase 2) stores the file. */
  assetId: string | null;
  notes: string;
}

export const PRESERVATION_OPTIONS = [
  'composition',
  'shape',
  'proportions',
  'silhouette',
  'mainSubject',
  'objectCount',
] as const;
export type Preservation = (typeof PRESERVATION_OPTIONS)[number];

export interface OriginalData extends ImageData {
  preserve: Record<Preservation, boolean>;
  instructions: string;
}

export const THEME_ROLES = ['artStyle', 'lighting', 'shading', 'material', 'mood', 'composition', 'texture'] as const;
export type ThemeRole = (typeof THEME_ROLES)[number];

export interface ThemeData extends ImageData {
  roles: ThemeRole[];
}

export const COLOR_ROLES = ['primary', 'secondary', 'accent', 'background', 'outline'] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export interface PaletteColor {
  id: string;
  hex: string;
  role: ColorRole;
  ratio: number | null;
}

export interface PaletteData extends BaseNodeData {
  colors: PaletteColor[];
}

/** One image in a collection. Items reference assets by id; files are never copied. */
export interface CollectionItem {
  /** Unique within its collection (stable key for reordering and edits). */
  id: string;
  assetId: string;
  /** Disabled items stay in the collection but are skipped by generation. */
  enabled: boolean;
  /** Extra prompt text used only for this image (spec "per-asset prompt override"). */
  promptOverride: string;
}

export interface CollectionData extends BaseNodeData {
  role: 'input' | 'output';
  description: string;
  /** Ordered items; stored in the graph so undo, copy/paste and auto-save cover them. */
  items: CollectionItem[];
}

export const ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
export const ASSET_CATEGORIES = [
  'Character',
  'Environment',
  'Prop',
  'Item',
  'Icon',
  'UI Element',
  'Decoration',
  'Background',
  'Concept Art',
  'Other',
] as const;

export interface GenerateData extends BaseNodeData {
  providerId: string;
  model: string;
  mode: 'manual' | 'match';
  outputCount: number;
  variantsPerInput: number;
  aspectRatio: (typeof ASPECT_RATIOS)[number];
  quality: 'auto' | 'low' | 'medium' | 'high';
  outputFormat: 'png' | 'webp' | 'jpg';
  background: 'white' | 'solid' | 'transparent' | 'custom';
  backgroundValue: string;
  assetCategory: (typeof ASSET_CATEGORIES)[number];
  artStyle: string;
  preserveSubject: boolean;
  preserveSilhouette: boolean;
  consistentFraming: boolean;
  consistentScale: boolean;
  /** Required in Manual Count mode when several originals are connected (spec §12.1 A3). */
  primaryOriginalNodeId: string | null;
}

export interface OutputData extends BaseNodeData {
  assetId: string | null;
  generationId: string | null;
}

export interface NodeDataByKind {
  prompt: PromptData;
  image: ImageData;
  original: OriginalData;
  theme: ThemeData;
  palette: PaletteData;
  collection: CollectionData;
  generate: GenerateData;
  output: OutputData;
}

export type AnyNodeData = NodeDataByKind[NodeKind];
export type CanvasNode = Node<AnyNodeData, NodeKind>;
export type CanvasEdge = Edge;
