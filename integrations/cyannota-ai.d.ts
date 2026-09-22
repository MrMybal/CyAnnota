export type CyAnnotaAiMediaKind = 'image' | 'video' | 'gif';
export type CyAnnotaAiAnnotationType = 'box' | 'arrow' | 'note' | 'freehand' | 'delete' | 'color' | 'frame' | 'shape';
export type CyAnnotaAiCategory = 'modifier' | 'ajouter' | 'supprimer' | 'deplacer' | 'question';

export interface CyAnnotaAiPoint {
  /** Normalized horizontal position from 0 (left) to 1 (right). */
  x: number;
  /** Normalized vertical position from 0 (top) to 1 (bottom). */
  y: number;
}

export interface CyAnnotaAiBox extends CyAnnotaAiPoint {
  width: number;
  height: number;
}

export interface CyAnnotaAiAnnotation {
  id?: string;
  type: CyAnnotaAiAnnotationType;
  message: string;
  category?: CyAnnotaAiCategory;
  color?: string;
  layerId?: string;
  groupId?: string;
  createdAt?: number;
  box?: CyAnnotaAiBox;
  from?: CyAnnotaAiPoint;
  to?: CyAnnotaAiPoint;
  point?: CyAnnotaAiPoint;
  points?: CyAnnotaAiPoint[];
  time?: { start: number; end: number };
  shape?: 'rectangle' | 'ellipse' | 'line';
  fillColor?: string;
  sampledColor?: string;
  replacementColor?: string;
}

export interface CyAnnotaAiTab {
  id: string;
  label: string;
  kind: CyAnnotaAiMediaKind;
  mediaName?: string;
  mediaPath?: string;
  width: number;
  height: number;
  duration?: number;
  trimStart?: number;
  trimEnd?: number;
  message?: string;
  annotations: CyAnnotaAiAnnotation[];
}

export interface CyAnnotaAiDocument {
  format: 'cyannota-ai';
  version: 1;
  title: string;
  locale: 'en' | 'fr';
  workspaceMessage: string;
  tabs: CyAnnotaAiTab[];
}

export type CyAnnotaAiOperation =
  | { op: 'set-title'; value: string }
  | { op: 'set-workspace-message'; value: string }
  | { op: 'set-tab-message'; tabId: string; value: string }
  | { op: 'add-annotation'; tabId: string; annotation: CyAnnotaAiAnnotation }
  | { op: 'update-annotation'; tabId: string; annotationId: string; patch: Partial<CyAnnotaAiAnnotation> }
  | { op: 'remove-annotation'; tabId: string; annotationId: string };

export interface CyAnnotaAiPackageOptions {
  JSZip?: unknown;
  media: Record<string, Blob> | Map<string, Blob>;
  thumbnail?: Blob;
  audience?: 'ai' | 'human';
}

export interface CyAnnotaAiPackageResult {
  archive: Blob;
  archiveName: string;
  document: CyAnnotaAiDocument;
  workspace: unknown;
  manifest: Record<string, unknown>;
  thumbnail: Blob | null;
  summary: {
    title: string;
    tabCount: number;
    imageCount: number;
    videoCount: number;
    annotationCount: number;
  };
}

export interface CyAnnotaAiApi {
  format: 'cyannota-ai';
  version: 1;
  createDocument(options?: Partial<Omit<CyAnnotaAiDocument, 'format' | 'version'>>): CyAnnotaAiDocument;
  validateDocument(document: unknown): { valid: boolean; errors: string[] };
  applyOperations(document: CyAnnotaAiDocument, operations: CyAnnotaAiOperation[]): CyAnnotaAiDocument;
  compileWorkspace(document: CyAnnotaAiDocument, options: Pick<CyAnnotaAiPackageOptions, 'media'>): Promise<unknown>;
  createPackage(document: CyAnnotaAiDocument, options: CyAnnotaAiPackageOptions): Promise<CyAnnotaAiPackageResult>;
  readPackage(source: Blob, options?: { JSZip?: unknown }): Promise<{ document: CyAnnotaAiDocument; media: Record<string, Blob> }>;
  editPackage(source: Blob, operations: CyAnnotaAiOperation[], options?: Omit<CyAnnotaAiPackageOptions, 'media'> & { media?: Record<string, Blob> }): Promise<CyAnnotaAiPackageResult>;
}

declare global {
  interface Window {
    CyAnnotaAI: CyAnnotaAiApi;
  }
}
