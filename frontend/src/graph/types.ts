import type { Edge, Node } from '@xyflow/react';

export type NodeKind = 'prompt' | 'image' | 'palette' | 'collection' | 'extract' | 'generate' | 'output' | 'text' | 'drawing';

/** Older saved projects had separate Original / Theme image nodes; they load as `image`. */
export const LEGACY_IMAGE_KINDS = ['original', 'theme'] as const;

/**
 * Value types that flow along edges (spec §25.1). `original` and `theme` are only port
 * colours now: every image node outputs `image`, and its role comes from the port it feeds.
 */
export type PortType = 'prompt' | 'image' | 'original' | 'theme' | 'palette' | 'assetList' | 'generated' | 'extracted';

export interface BaseNodeData {
  title: string;
  collapsed: boolean;
  locked: boolean;
  /**
   * Set while this node is folded into another node's generate button (the Cropped assets collection of an
   * Extract flow): it is hidden but still part of the graph, so planning and generation are unchanged.
   */
  groupId?: string | null;
  inlineGeneration?: {
    id: string;
    assetId: string;
    prompt: string;
    settings: Partial<GenerateData>;
    batchIds: string[];
    /** Variation: the images this result came from (the original screenshot), sent along as secondary originals for context. */
    contextAssetIds?: string[];
  };
  [key: string]: unknown;
}

/** The user request that fills the chosen preset's template (the art direction notes can go here too). */
export interface PromptData extends BaseNodeData {
  text: string;
  enabled: boolean;
}

export const THEME_ROLES = ['artStyle', 'lighting', 'shading', 'material', 'mood', 'composition', 'texture'] as const;
export type ThemeRole = (typeof THEME_ROLES)[number];

/**
 * One image. What it is used as (original, theme or reference) is decided by the Generate
 * port it connects to, so it carries the settings for every role.
 */
/** One asset an AI model found in an image, as a box relative to the image (0..1). */
export interface DetectedAsset {
  name: string;
  description: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageData extends BaseNodeData {
  assetId: string | null;
  notes: string;
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
  /** Input collections that own a folded Extract workflow: the Prompt, Generate and style Image nodes hidden behind its button. */
  foldedIds?: string[];
}

/** `match` = closest preset to the original image's shape (resolved per task by the backend). */
export const ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', 'match'] as const;
export const aspectLabel = (a: string) => (a === 'match' ? 'Match original' : a);

/** The prompt presets. The wording lives in the backend (`generation/presets.py`). */
export const PRESETS = [
  {
    id: 'screen',
    label: 'Game screen restyle',
    description: 'Restyle the whole screen from the user request; gameplay, layout and HUD stay the same.',
  },
  {
    id: 'assets',
    label: 'Asset sheet',
    description: 'Create a clean sheet of the gameplay assets in the image, in the requested style, on a transparent background.',
  },
  {
    id: 'free',
    label: 'Free prompt',
    description: 'Your prompt goes to the model as written, with no game template. Attached images, palette and aspect ratio are still described.',
  },
] as const;
export type PresetId = (typeof PRESETS)[number]['id'];

/** Find boxes; Build asset sheet crops selected assets into a collection and adds background removal. */
export interface ExtractData extends BaseNodeData {
  hint: string;
  /** Vision model used to find assets; empty uses the server default (Luna). */
  model?: string;
  /** Thinking effort; empty is automatic: maximum for Luna, light for larger models. */
  effort?: string;
  /** Result of the last search, for the image it was run on (ignored once that image changes). */
  detections: { assetId: string; model: string | null; seconds: number; items: DetectedAsset[] } | null;
  /** Indexes of detections the user unticked. */
  off: number[];
  /** The Generate node built from this search, so pressing the button again updates it instead of adding one. */
  generateNodeId: string | null;
  collectionNodeId: string | null;
}

export interface GenerateData extends BaseNodeData {
  providerId: string;
  model: string;
  preset: PresetId;
  /** Regenerate edits the connected result, without a restyle/asset-sheet template. */
  editResult?: boolean;
  /** Asset sheet preset: which assets to create ("pots, ice and number badges"); empty = let the AI decide. */
  assetSelection: string;
  mode: 'manual' | 'match';
  outputCount: number;
  variantsPerInput: number;
  aspectRatio: (typeof ASPECT_RATIOS)[number];
  quality: 'auto' | 'low' | 'medium' | 'high';
  outputFormat: 'png' | 'webp' | 'jpg';
  /** Required in Manual Count mode when several originals are connected (spec §12.1 A3). */
  primaryOriginalNodeId: string | null;
}

export interface OutputData extends BaseNodeData {
  sourceNodeId?: string;
  resultAction?: 'retry' | 'variation';
  assetId: string | null;
  /** Batch that produced (or will produce) this result. */
  generationId: string | null;
  /** Task whose output was placed here. */
  taskId: string | null;
  /** A regenerated result waits for this slot and attempt, ignoring older outputs. */
  pendingSlot?: number;
  pendingAttempt?: number;
}

export interface NodeDataByKind {
  text: BaseNodeData & { text: string; color: string; fontSize: number; comment: boolean };
  drawing: BaseNodeData & { points: { x: number; y: number }[]; color: string; strokeWidth: number; canvasWidth: number; canvasHeight: number };
  prompt: PromptData;
  image: ImageData;
  palette: PaletteData;
  collection: CollectionData;
  extract: ExtractData;
  generate: GenerateData;
  output: OutputData;
}

export type AnyNodeData = NodeDataByKind[NodeKind];
export type CanvasNode = Node<AnyNodeData, NodeKind>;
export type CanvasEdge = Edge;
