export type CyAnnotaMediaKind = 'image' | 'video' | 'project';
export type CyAnnotaResultMode = 'archive' | 'direct' | 'both';

export interface CyAnnotaSummary {
  title: string;
  tabCount: number;
  imageCount: number;
  videoCount: number;
  annotationCount: number;
}

export interface CyAnnotaDirectFile {
  path: string;
  type: string;
  size: number;
  blob: Blob;
}

export interface CyAnnotaSendResult {
  attachmentId: string;
  archiveName?: string;
  archive?: Blob;
  files?: CyAnnotaDirectFile[];
  document: unknown;
  manifest: Record<string, unknown>;
  thumbnail: Blob;
  summary: CyAnnotaSummary;
  exportPreferences: {
    audience: 'ai' | 'human';
    container: 'zip' | 'project';
    includeOriginalVideos: boolean;
    optimizeImages: boolean;
    locale: 'en' | 'fr';
    resultMode: CyAnnotaResultMode;
  };
}

export interface CyAnnotaOpenOptions {
  cyAnnotaUrl?: string;
  integrationId: string;
  integrationName?: string;
  attachmentId?: string;
  mediaId?: string;
  session?: string;
  title?: string;
  file: Blob | File;
  mediaKind?: CyAnnotaMediaKind;
  document?: unknown;
  readOnly?: boolean;
  maximumDocumentBytes?: number;
  maximumResultBytes?: number;
  exportAudience?: 'ai' | 'human';
  exportContainer?: 'zip' | 'project';
  includeOriginalVideos?: boolean;
  resultMode?: CyAnnotaResultMode;
  closeOnSend?: boolean;
  locale?: 'en' | 'fr';
  container?: HTMLElement;
  height?: string;
  iframeClassName?: string;
  iframeTitle?: string;
  windowName?: string;
  windowFeatures?: string;
  onReady?: (capabilities: Record<string, unknown>) => void;
  onSend?: (result: CyAnnotaSendResult) => Promise<{ revision?: number } | void> | { revision?: number } | void;
  onSave?: (result: CyAnnotaSendResult) => Promise<{ revision?: number } | void> | { revision?: number } | void;
  onClose?: (event: { attachmentId: string; reason: string }) => void;
}

export interface CyAnnotaEditorHandle {
  session: string;
  popup: Window | null;
  iframe: HTMLIFrameElement | null;
  ready: Promise<{ session: string; capabilities: Record<string, unknown> }>;
  close(closePopup?: boolean): void;
}

export interface CyAnnotaPackagePreview {
  manifest: Record<string, unknown>;
  workspace: unknown;
  thumbnail: Blob | null;
  summary: CyAnnotaSummary;
  files: string[];
  readFile(path: string, outputType?: 'blob' | 'string' | 'uint8array' | 'arraybuffer'): Promise<unknown>;
}

export interface CyAnnotaIntegrationApi {
  protocol: 'cyannota.integration';
  protocolVersion: 2;
  open(options: CyAnnotaOpenOptions): CyAnnotaEditorHandle;
  readDocument(source: Blob | string | object): Promise<{ document: unknown; summary: CyAnnotaSummary }>;
  readPackage(source: Blob, options?: { JSZip?: unknown }): Promise<CyAnnotaPackagePreview>;
  summarizeDocument(document: unknown): CyAnnotaSummary;
  archiveFile(result: CyAnnotaSendResult): File;
  mountPreview(container: HTMLElement, preview: CyAnnotaPackagePreview | CyAnnotaSendResult, options?: { className?: string }): () => void;
}

declare global {
  interface Window {
    CyAnnotaIntegration: CyAnnotaIntegrationApi;
  }
}
