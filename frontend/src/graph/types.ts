import type { Edge, Node } from '@xyflow/react';

export type NodeKind = 'prompt' | 'image' | 'palette' | 'collection' | 'generate' | 'output';

/** Older saved projects had separate Original / Theme image nodes; they load as `image`. */
export const LEGACY_IMAGE_KINDS = ['original', 'theme'] as const;

/**
 * Value types that flow along edges (spec §25.1). `original` and `theme` are only port
 * colours now: every image node outputs `image`, and its role comes from the port it feeds.
 */
export type PortType = 'prompt' | 'image' | 'original' | 'theme' | 'palette' | 'assetList' | 'generated';

export interface BaseNodeData {
  title: string;
  collapsed: boolean;
  locked: boolean;
  [key: string]: unknown;
}

/** Game-asset settings travel with the prompt (the first prompt feeding a Generate node decides). */
export const GAME_ASSET_KEYS = [
  'assetCategory',
  'artStyle',
  'preserveSubject',
  'preserveSilhouette',
  'consistentFraming',
  'consistentScale',
] as const;

export interface PromptData extends BaseNodeData {
  text: string;
  constraints: string;
  enabled: boolean;
  role: 'main' | 'style' | 'constraints' | 'output';
  order: number;
  assetCategory: (typeof ASSET_CATEGORIES)[number];
  artStyle: string;
  preserveSubject: boolean;
  preserveSilhouette: boolean;
  consistentFraming: boolean;
  consistentScale: boolean;
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

export const THEME_ROLES = ['artStyle', 'lighting', 'shading', 'material', 'mood', 'composition', 'texture'] as const;
export type ThemeRole = (typeof THEME_ROLES)[number];

/**
 * One image. What it is used as (original, theme or reference) is decided by the Generate
 * port it connects to, so it carries the settings for every role.
 */
export interface ImageData extends BaseNodeData {
  assetId: string | null;
  notes: string;
  /** Used when connected to an Original port. */
  preserve: Record<Preservation, boolean>;
  instructions: string;
  /** Used when connected to a Theme port. */
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
  /** How many colours to take when extracting from a connected image. */
  extractCount: number;
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
  /** Output collections: generation batches whose results land here. */
  batchIds: string[];
  /** Output collections: tasks already added, so a removed result is not added back on re-sync. */
  syncedTaskIds: string[];
}

/** `match` = closest preset to the original image's shape (resolved per task by the backend). */
export const ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', 'match'] as const;
export const aspectLabel = (a: string) => (a === 'match' ? 'Match original' : a);
/** A whole game screen, re-themed with the same gameplay and layout. */
export const GAME_SCREEN = 'Game Screen';
export const ASSET_CATEGORIES = [
  'Game Screen',
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
  /** Required in Manual Count mode when several originals are connected (spec §12.1 A3). */
  primaryOriginalNodeId: string | null;
}

export interface OutputData extends BaseNodeData {
  assetId: string | null;
  /** Batch that produced (or will produce) this result. */
  generationId: string | null;
  /** Task whose output was placed here. */
  taskId: string | null;
}

export interface NodeDataByKind {
  prompt: PromptData;
  image: ImageData;
  palette: PaletteData;
  collection: CollectionData;
  generate: GenerateData;
  output: OutputData;
}

export type AnyNodeData = NodeDataByKind[NodeKind];
export type CanvasNode = Node<AnyNodeData, NodeKind>;
export type CanvasEdge = Edge;
