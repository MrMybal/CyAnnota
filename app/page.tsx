'use client';

import JSZip from 'jszip';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isAppLocale,
  translate,
  type AppLocale,
} from './i18n';
import VersionStatus from './version-status';
import VideoAnnotator, {
  buildVideoPrompt,
  createVideoDeliveryProject,
  encodeTrimmedVideo,
  renderAnnotatedVideoFrameStop,
  videoFrameStopAnnotatedFileName,
  videoFrameStopFileName,
  videoTrimBounds,
  type VideoOutputFormat,
  type VideoProjectData,
} from './video-annotator';
import {
  ChangeEvent,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type Tool = 'select' | 'pan' | 'frame' | 'shape' | 'rect' | 'arrow' | 'text' | 'draw' | 'cut' | 'resize' | 'polycut' | 'delete' | 'eyedropper';
type Category = 'modifier' | 'ajouter' | 'supprimer' | 'deplacer' | 'question';
type Point = { x: number; y: number };
type Layer = { id: string; name: string; color: string; visible: boolean };
type ReferenceImage = { id: string; name: string; dataUrl: string };

type AnnotationBase = {
  id: string;
  layerId: string;
  color: string;
  description: string;
  category: Category;
  references: ReferenceImage[];
  createdAt: number;
  groupId?: string;
};

type RectAnnotation = AnnotationBase & {
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
};

type ArrowAnnotation = AnnotationBase & {
  type: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type TextAnnotation = AnnotationBase & {
  type: 'text';
  x: number;
  y: number;
};

type DrawAnnotation = AnnotationBase & {
  type: 'draw';
  points: Point[];
};

type CutAnnotation = AnnotationBase & {
  type: 'cut';
  sourceX: number;
  sourceY: number;
  x: number;
  y: number;
  w: number;
  h: number;
  imageData: string;
  polygon?: Point[];
};


type ResizeAnnotation = AnnotationBase & {
  type: 'resize';
  sourceX: number;
  sourceY: number;
  sourceW: number;
  sourceH: number;
  x: number;
  y: number;
  w: number;
  h: number;
  imageData: string;
  lockAspectRatio: boolean;
};
type FrameAnnotation = AnnotationBase & {
  type: 'frame';
  x: number;
  y: number;
  w: number;
  h: number;
};

type ShapeAnnotation = AnnotationBase & {
  type: 'shape';
  shape: 'rectangle' | 'ellipse' | 'line';
  x: number;
  y: number;
  w: number;
  h: number;
  fillColor: string;
};

type DeleteAnnotation = AnnotationBase & {
  type: 'delete';
  x: number;
  y: number;
  w: number;
  h: number;
};

type ColorAnnotation = AnnotationBase & {
  type: 'color';
  x: number;
  y: number;
  sampledColor: string;
  replacementColor: string;
};

type Annotation =
  | RectAnnotation
  | ArrowAnnotation
  | TextAnnotation
  | DrawAnnotation
  | CutAnnotation
  | ResizeAnnotation
  | FrameAnnotation
  | ShapeAnnotation
  | DeleteAnnotation
  | ColorAnnotation;

type Draft = {
  tool: Exclude<Tool, 'select' | 'text' | 'pan' | 'polycut' | 'eyedropper'>;
  start: Point;
  end: Point;
  points: Point[];
};

type DragState =
  | { kind: 'create'; draft: Draft }
  | { kind: 'move'; id: string; start: Point; original: Annotation; before: Annotation[] }
  | { kind: 'resize'; id: string; start: Point; original: ResizeAnnotation; before: Annotation[] }
  | {
      kind: 'pan';
      clientX: number;
      clientY: number;
      panX: number;
      panY: number;
    };

type ProjectFile = {
  version: 1;
  title: string;
  globalInstructions: string;
  image: { src: string; name: string } | null;
  layers: Layer[];
  annotations: Annotation[];
};

type ExportAudience = 'ai' | 'human';
type ExportContainer = 'zip' | 'project';

type IntegrationBridge = {
  providerId: string;
  providerLabel: string;
  session: string;
  parentOrigin: string;
  attachmentId: string;
  readOnly: boolean;
  maximumDocumentBytes: number;
};

type IntegrationBridgeMessage = {
  source?: unknown;
  type?: unknown;
  session?: unknown;
  attachmentId?: unknown;
  taskId?: unknown;
  title?: unknown;
  mediaKind?: unknown;
  file?: unknown;
  document?: unknown;
  readOnly?: unknown;
  maximumDocumentBytes?: unknown;
  exportAudience?: unknown;
  exportContainer?: unknown;
  includeOriginalVideos?: unknown;
  locale?: unknown;
  ok?: unknown;
  revision?: unknown;
  error?: unknown;
};

type ImageBoardTab = {
  id: string;
  label: string;
  kind: 'image';
  project: ProjectFile;
};

type VideoBoardTab = {
  id: string;
  label: string;
  kind: 'video';
  file: File;
  project: VideoProjectData;
};

type BoardTab = ImageBoardTab | VideoBoardTab;

function initialLayers(locale: AppLocale = DEFAULT_LOCALE): Layer[] {
  return [
    { id: 'ui', name: translate(locale, 'UI corrections', 'Corrections UI'), color: '#ff5c49', visible: true },
    { id: 'questions', name: 'Questions', color: '#e9ad4a', visible: true },
  ];
}

function createBlankProject(locale: AppLocale = DEFAULT_LOCALE): ProjectFile {
  return {
    version: 1,
    title: translate(locale, 'Interface corrections', 'Corrections interface'),
    globalInstructions: '',
    image: null,
    layers: initialLayers(locale),
    annotations: [],
  };
}


const LEGACY_EMPTY_FRAME_MESSAGES = new Set([
  'Every item placed inside this frame belongs to the same correction.',
  'Tous les éléments placés dans ce cadre font partie de la même correction.',
]);

function hasFrameInstruction(description: string) {
  const message = description.trim();
  return Boolean(message) && !LEGACY_EMPTY_FRAME_MESSAGES.has(message);
}

function createImageDeliveryProject(project: ProjectFile): ProjectFile {
  const ignoredFrameIds = new Set(
    project.annotations
      .filter((annotation) => annotation.type === 'frame' && !hasFrameInstruction(annotation.description))
      .map((annotation) => annotation.id),
  );

  if (!ignoredFrameIds.size) return project;

  return {
    ...project,
    annotations: project.annotations
      .filter((annotation) => !ignoredFrameIds.has(annotation.id))
      .map((annotation) =>
        annotation.groupId && ignoredFrameIds.has(annotation.groupId)
          ? { ...annotation, groupId: undefined }
          : annotation,
      ),
  };
}

const TOOL_LABELS: Record<AppLocale, Record<Tool, string>> = {
  en: {
    select: 'Select and move', pan: 'Hand — move view', frame: 'Group frame', shape: 'Simple shape',
    rect: 'Frame an area', arrow: 'Draw an arrow', text: 'Place a note', draw: 'Freehand draw',
    cut: 'Rectangular cutout', resize: 'Resize a captured area', polycut: 'Polygonal cutout', delete: 'Delete area', eyedropper: 'Color picker',
  },
  fr: {
    select: 'Sélectionner et déplacer', pan: 'Main — déplacer la vue', frame: 'Cadre de groupe', shape: 'Forme simple',
    rect: 'Encadrer une zone', arrow: 'Tracer une flèche', text: 'Placer une note', draw: 'Dessiner librement',
    cut: 'Découpe rectangulaire', resize: 'Redimensionner une zone', polycut: 'Découpe polygonale', delete: 'Zone à supprimer', eyedropper: 'Pipette de couleur',
  },
};

const TOOL_HELP: Record<AppLocale, Record<Tool, string>> = {
  en: {
    select: 'Click a correction or cutout to move it.', pan: 'Drag the image. Shortcuts: right-click or Space + drag.',
    frame: 'Create a frame; shapes and text placed inside will be linked to it.', shape: 'Draw a simple shape, then choose rectangle, ellipse, or line.',
    rect: 'Drag around the area to correct.', arrow: 'Drag from the starting point to the target.', text: 'Click where you want to place a note.',
    draw: 'Hold and draw directly on the capture.', cut: 'Drag around an element, then move the created cutout.', resize: 'Frame an area, then resize the extracted pixels with the handle or size controls.',
    polycut: 'Click the vertices, then double-click or click the first point to close.', delete: 'Frame an area to mark it automatically for deletion.',
    eyedropper: 'Pick a color, then choose its replacement.',
  },
  fr: {
    select: 'Clique une correction ou une découpe pour la déplacer.', pan: 'Fais glisser l’image. Raccourcis : clic droit ou Espace + glisser.',
    frame: 'Crée un cadre ; les formes et textes posés dedans lui seront liés.', shape: 'Dessine une forme simple, puis choisis rectangle, ellipse ou ligne.',
    rect: 'Glisse autour de la zone à corriger.', arrow: 'Glisse du point de départ vers la cible.', text: 'Clique à l’endroit où placer une note.',
    draw: 'Maintiens et dessine directement sur la capture.', cut: 'Glisse autour d’un élément, puis déplace la découpe créée.', resize: 'Encadre une zone, puis redimensionne les pixels extraits avec la poignée ou les contrôles de taille.',
    polycut: 'Clique les sommets puis double-clique ou clique le premier point pour fermer.', delete: 'Encadre une zone : elle sera automatiquement marquée à supprimer.',
    eyedropper: 'Clique une couleur, puis choisis la couleur de remplacement.',
  },
};

const CATEGORY_LABELS: Record<AppLocale, Record<Category, string>> = {
  en: { modifier: 'Modify', ajouter: 'Add', supprimer: 'Delete', deplacer: 'Move', question: 'Question' },
  fr: { modifier: 'Modifier', ajouter: 'Ajouter', supprimer: 'Supprimer', deplacer: 'Déplacer', question: 'Question' },
};

const TYPE_LABELS: Record<AppLocale, Record<Annotation['type'], string>> = {
  en: { rect: 'Area', arrow: 'Arrow', text: 'Note', draw: 'Drawing', cut: 'Moved cutout', resize: 'Resized cutout', frame: 'Group frame', shape: 'Shape', delete: 'Deleted area', color: 'Color' },
  fr: { rect: 'Zone', arrow: 'Flèche', text: 'Note', draw: 'Dessin', cut: 'Découpe déplacée', resize: 'Découpe redimensionnée', frame: 'Cadre de groupe', shape: 'Forme', delete: 'Zone supprimée', color: 'Couleur' },
};

function createId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneAnnotations(value: Annotation[]) {
  return structuredClone(value);
}

function normalizeRect(a: Point, b: Point) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function annotationBounds(annotation: Annotation) {
  if (
    annotation.type === 'rect' ||
    annotation.type === 'cut' ||
    annotation.type === 'frame' ||
    annotation.type === 'shape' ||
    annotation.type === 'resize' ||
    annotation.type === 'delete'
  ) {
    return { x: annotation.x, y: annotation.y, w: annotation.w, h: annotation.h };
  }
  if (annotation.type === 'arrow') {
    return normalizeRect(
      { x: annotation.x1, y: annotation.y1 },
      { x: annotation.x2, y: annotation.y2 },
    );
  }
  if (annotation.type === 'text') {
    return { x: annotation.x, y: annotation.y - 28, w: 150, h: 34 };
  }
  if (annotation.type === 'color') {
    return { x: annotation.x - 18, y: annotation.y - 18, w: 96, h: 36 };
  }
  const xs = annotation.points.map((point) => point.x);
  const ys = annotation.points.map((point) => point.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

function pointSegmentDistance(point: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function moveAnnotation(annotation: Annotation, dx: number, dy: number): Annotation {
  if (
    annotation.type === 'rect' ||
    annotation.type === 'cut' ||
    annotation.type === 'text' ||
    annotation.type === 'frame' ||
    annotation.type === 'resize' ||
    annotation.type === 'shape' ||
    annotation.type === 'delete' ||
    annotation.type === 'color'
  ) {
    return { ...annotation, x: annotation.x + dx, y: annotation.y + dy };
  }
  if (annotation.type === 'arrow') {
    return {
      ...annotation,
      x1: annotation.x1 + dx,
      y1: annotation.y1 + dy,
      x2: annotation.x2 + dx,
      y2: annotation.y2 + dy,
    };
  }
  return {
    ...annotation,
    points: annotation.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  };
}

function safeFileName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'fichier';
}

function createVideoSaveProject(project: VideoProjectData): VideoProjectData {
  const bounds = videoTrimBounds(project);
  const deliveryProject = createVideoDeliveryProject(project, true);
  return {
    ...project,
    trimStart: bounds.start,
    trimEnd: bounds.end,
    trimmedPath: deliveryProject.sourcePath,
    originalSourcePath: project.sourcePath,
    originalIncluded: true,
  };
}

function formatVideoTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const milliseconds = Math.floor((safe % 1) * 1000);
  return (
    (hours ? String(hours).padStart(2, '0') + ':' : '') +
    String(minutes).padStart(2, '0') + ':' +
    String(seconds).padStart(2, '0') + '.' +
    String(milliseconds).padStart(3, '0')
  );
}

function dataUrlBytes(source: string, label: string) {
  const separator = source.indexOf(',');
  if (!source.startsWith('data:') || separator < 0) {
    throw new Error(`${label} n’est pas incorporée au projet.`);
  }

  const metadata = source.slice(5, separator);
  const payload = source.slice(separator + 1);
  try {
    if (metadata.split(';').includes('base64')) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} est illisible : ${detail}`);
  }
}

type PreparedFileSave = {
  name: string;
  desktopToken?: string;
  desktopFileName?: string;
  desktopRenamed?: boolean;
};

type SaveBlobResult = {
  saved: boolean;
  copied: boolean;
  fileName: string;
  renamed: boolean;
  copyError?: string;

};
async function prepareFileSave(name: string): Promise<PreparedFileSave | null> {
  if (!window.cyAnnotaDesktop) return { name };

  const result = await window.cyAnnotaDesktop.chooseSaveFile({ name });
  if (result.canceled || !result.token) return null;
  return {
    name,
    desktopToken: result.token,
    desktopFileName: result.fileName,
    desktopRenamed: result.renamed,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const characterChunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += characterChunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + characterChunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}

async function showSaveFailure(message: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error || 'Erreur inconnue');
  if (window.cyAnnotaDesktop) {
    try {
      await window.cyAnnotaDesktop.showErrorMessage({
        title: 'CyAnnota - erreur de sauvegarde',
        message,
        detail:
          detail +
          '\n\nLe fichier final n’a pas été remplacé. Vous pouvez fermer cette fenêtre et réessayer.',
      });
      return;
    } catch {
      // Le dialogue natif a lui-même échoué : le navigateur garde un dernier recours visible.
    }
  }
  window.alert(message + '\n\nDétail technique : ' + detail);
}

async function savePreparedBlob(
  blob: Blob,
  prepared: PreparedFileSave,
  options: { copyToClipboard?: boolean } = {},
): Promise<SaveBlobResult> {
async function copyBlobToClipboard(blob: Blob, name: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Ce navigateur ne permet pas de copier un fichier dans le presse-papiers.');
  }
  const mimeType = blob.type || 'application/octet-stream';
  const file = new File([blob], name, { type: mimeType, lastModified: Date.now() });
  await navigator.clipboard.write([
    new ClipboardItem({ [mimeType]: file }, { presentationStyle: 'attachment' }),
  ]);
}

  if (prepared.desktopToken) {
    if (!window.cyAnnotaDesktop) throw new Error('Pont de sauvegarde desktop indisponible');
    if (!blob.size) throw new Error('Le fichier généré est vide.');

    const desktop = window.cyAnnotaDesktop;
    const token = prepared.desktopToken;
    try {
      await desktop.beginSaveFile({ token });
      const chunkSize = 512 * 1024;
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const slice = blob.slice(offset, Math.min(offset + chunkSize, blob.size));
        const base64 = arrayBufferToBase64(await slice.arrayBuffer());
        const result = await desktop.writeSaveChunk({ token, base64 });
        if (result.written !== slice.size) {
          throw new Error(`Écriture incomplète : ${result.written} octets sur ${slice.size}.`);
        }
      }
      const result = await desktop.finishSaveFile({
        token,
        copyToClipboard: options.copyToClipboard === true,
      });
      if (result.bytesWritten !== blob.size) {
        throw new Error(`Fichier incomplet : ${result.bytesWritten} octets sur ${blob.size}.`);
      }
      return {
        saved: result.saved,
        copied: result.copied,
        fileName: result.fileName || prepared.desktopFileName || prepared.name,
        renamed: result.renamed || prepared.desktopRenamed === true,
        copyError: result.copyError,
      };
    } catch (error) {
      await desktop.abortSaveFile({ token }).catch(() => undefined);
      throw error;
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = prepared.name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  let copied = false;
  let copyError: string | undefined;
  if (options.copyToClipboard) {
    try {
      await copyBlobToClipboard(blob, prepared.name);
      copied = true;
    } catch (error) {
      copyError = error instanceof Error ? error.message : String(error);
    }
  }
  return { saved: true, copied, fileName: prepared.name, renamed: false, copyError };
}

async function downloadBlob(blob: Blob, name: string) {
  const prepared = await prepareFileSave(name);
  if (!prepared) return false;
  return (await savePreparedBlob(blob, prepared)).saved;
}

const VIDEO_FILE_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'mov', 'm4v', 'gif']);

function fileExtension(file: Pick<File, 'name'>) {
  return file.name.split('.').pop()?.toLowerCase() || '';
}

function isGifFile(file: Pick<File, 'name' | 'type'>) {
  return file.type.toLowerCase() === 'image/gif' || fileExtension(file) === 'gif';
}

function isVideoMediaFile(file: Pick<File, 'name' | 'type'>) {
  return file.type.startsWith('video/') || isGifFile(file) || VIDEO_FILE_EXTENSIONS.has(fileExtension(file));
}

function isStillImageFile(file: Pick<File, 'name' | 'type'>) {
  return !isGifFile(file) && (
    file.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp'].includes(fileExtension(file))
  );
}

function clipboardMediaName(mimeType: string) {
  const extension = mimeType === 'image/jpeg'
    ? 'jpg'
    : mimeType === 'video/quicktime'
      ? 'mov'
      : mimeType.split('/')[1]?.replace('x-', '') || 'bin';
  return 'media-colle-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + extension;
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function openDraftDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('annota-local', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('projects')) {
        request.result.createObjectStore('projects');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeDraft(project: ProjectFile) {
  const database = await openDraftDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('projects', 'readwrite');
    transaction.objectStore('projects').put(project, 'last');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function readDraft() {
  const database = await openDraftDatabase();
  const result = await new Promise<ProjectFile | undefined>((resolve, reject) => {
    const request = database.transaction('projects', 'readonly').objectStore('projects').get('last');
    request.onsuccess = () => resolve(request.result as ProjectFile | undefined);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return result;
}

export default function Home() {
  const [locale, setLocale] = useState<AppLocale>(DEFAULT_LOCALE);
  const t = (english: string, french: string) => translate(locale, english, french);
  const [tool, setTool] = useState<Tool>('select');
  const [tabs, setTabs] = useState<BoardTab[]>([
    { id: 'board-1', label: 'New image', kind: 'image', project: createBlankProject(DEFAULT_LOCALE) },
  ]);
  const [activeTabId, setActiveTabId] = useState('board-1');
  const [imageSource, setImageSource] = useState<string | null>(null);
  const [imageName, setImageName] = useState('Aucune capture');
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [layers, setLayers] = useState<Layer[]>(() => initialLayers(DEFAULT_LOCALE));
  const [activeLayerId, setActiveLayerId] = useState('ui');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [past, setPast] = useState<Annotation[][]>([]);
  const [future, setFuture] = useState<Annotation[][]>([]);
  const [projectTitle, setProjectTitle] = useState('Interface corrections');
  const [globalInstructions, setGlobalInstructions] = useState('');
  const [workspaceInstructions, setWorkspaceInstructions] = useState('');
  const [workspaceMessageOpen, setWorkspaceMessageOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPrompt, setExportPrompt] = useState('');
  const [exportAudience, setExportAudience] = useState<ExportAudience>('ai');
  const [exportContainer, setExportContainer] = useState<ExportContainer>('zip');
  const [includeOriginalVideosInExport, setIncludeOriginalVideosInExport] = useState(false);
  const [copyExportToClipboard, setCopyExportToClipboard] = useState(true);
  const [preserveGifFormatInExport, setPreserveGifFormatInExport] = useState(false);
  const [exportProgressLabel, setExportProgressLabel] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [hasLocalDraft, setHasLocalDraft] = useState(false);
  const [saveStatus, setSaveStatus] = useState('Ready');
  const [renderTick, setRenderTick] = useState(0);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const [isPanning, setIsPanning] = useState(false);
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const [polygonPoints, setPolygonPoints] = useState<Point[]>([]);
  const [isDraggingReference, setIsDraggingReference] = useState(false);
  const [integrationBridge, setIntegrationBridge] = useState<IntegrationBridge | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const annotationsRef = useRef<Annotation[]>(annotations);
  const globalInstructionsRef = useRef(globalInstructions);
  const cutImageCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const colorSampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const importNoticeTimer = useRef<number | null>(null);
  const spaceHeldRef = useRef(false);
  const zoomRef = useRef(zoom);
  const panRef = useRef<Point>(pan);
  const integrationBridgeRef = useRef<IntegrationBridge | null>(null);
  const encodedVideoCacheRef = useRef(new Map<string, { signature: string; blob: Blob }>());
  const localeReadyRef = useRef(false);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  const hasExportableMedia = tabs.some(
    (tab) => tab.kind === 'video' || Boolean(tab.project.image),
  );
  const selected = annotations.find((annotation) => annotation.id === selectedId) ?? null;
  const activeLayer = layers.find((layer) => layer.id === activeLayerId) ?? layers[0];
  const visibleLayerIds = useMemo(
    () => new Set(layers.filter((layer) => layer.visible).map((layer) => layer.id)),
    [layers],
  );

  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  useEffect(() => {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isAppLocale(saved) && saved !== DEFAULT_LOCALE) {
      const timer = window.setTimeout(() => {
        localeReadyRef.current = true;
        setLocale(saved);
        setProjectTitle((current) => current === 'Interface corrections' ? 'Corrections interface' : current);
        setLayers((items) => items.map((layer) => ({
          ...layer,
          name: layer.name === 'UI corrections' ? 'Corrections UI' : layer.name,
        })));
      }, 0);
      return () => window.clearTimeout(timer);
    }
    localeReadyRef.current = true;
    document.documentElement.lang = DEFAULT_LOCALE;
  }, []);

  useEffect(() => {
    if (!localeReadyRef.current) return;
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const providerId = (parameters.get('integration') || '').toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(providerId) || !window.opener) return;

    const session = parameters.get('session') || '';
    const attachmentId = parameters.get('attachmentId') || parameters.get('mediaId') || 'media';
    const requestedLabel = (parameters.get('integrationName') || '').trim();
    const providerLabel = requestedLabel.slice(0, 50) || (
      providerId === 'cytask' ? 'CyTask' : providerId === 'cycapture' ? 'CyCapture' : providerId
    );
    const requestedParentOrigin = parameters.get('parentOrigin') || '';
    let parentOrigin = '';
    try {
      const parsed = new URL(requestedParentOrigin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== requestedParentOrigin) return;
      parentOrigin = parsed.origin;
    } catch {
      return;
    }
    if (!session || !attachmentId) return;

    const opener = window.opener;
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== opener || event.origin !== parentOrigin || !isRecord(event.data)) return;
      const message = event.data as IntegrationBridgeMessage;
      if (message.source !== providerId || message.session !== session) return;

      if (message.type === 'open-media' && message.attachmentId === attachmentId) {
        openIntegrationMedia(message, parentOrigin, session, attachmentId, providerId, providerLabel).catch((error) => {
          const text = error instanceof Error ? error.message : t('Invalid integration media', 'Média d’intégration invalide');
          setSaveStatus(t('Failed to load ', 'Échec du chargement ') + providerLabel);
          showImportNotice(text);
        });
        return;
      }

      if (message.type === 'save-result') {
        if (message.ok === true) {
          setSaveStatus(
            typeof message.revision === 'number'
              ? t('Saved to ', 'Enregistré dans ') + providerLabel + t(' · rev. ', ' · rév. ') + message.revision
              : t('Saved to ', 'Enregistré dans ') + providerLabel,
          );
          showImportNotice(t('Annotations saved to ', 'Annotations enregistrées dans ') + providerLabel);
        } else {
          const text = typeof message.error === 'string'
            ? message.error
            : providerLabel + t(' rejected the save', ' a refusé la sauvegarde');
          setSaveStatus(t('Save rejected by ', 'Sauvegarde ') + providerLabel + t('', ' refusée'));
          showImportNotice(text);
        }
      }
    };

    window.addEventListener('message', receive);
    opener.postMessage({
      source: 'cyannota',
      type: 'ready',
      protocol: 'cyannota.integration',
      protocolVersion: 1,
      session,
      capabilities: {
        media: ['image', 'video'],
        exportAudiences: ['ai', 'human'],
        exportContainers: ['zip', 'project'],
        projectExtension: '.cyannota',
        locales: ['en', 'fr'],
        defaultLocale: DEFAULT_LOCALE,
      },
    }, parentOrigin);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    const desktop = window.cyAnnotaDesktop;
    if (!desktop?.onOpenFiles) return;
    return desktop.onOpenFiles((items) => {
      void (async () => {
        for (const item of items) {
          const file = new File([item.bytes], item.name, {
            type: item.type || 'application/octet-stream',
            lastModified: Date.now(),
          });
          const lowerName = item.name.toLowerCase();
          if (lowerName.endsWith('.cyannota') || lowerName.endsWith('.zip')) {
            await openProjectFile(file);
          } else if (isVideoMediaFile(file)) {
            loadVideoFile(file);
          } else if (isStillImageFile(file)) {
            await loadImageFile(file);
          }
        }
      })().catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        setSaveStatus(t('External open failed', 'Ouverture externe impossible'));
        showImportNotice(t('CyAnnota cannot open the file: ', 'CyAnnota ne peut pas ouvrir le fichier : ') + detail);
      });
    });
  });

  async function openIntegrationMedia(
    message: IntegrationBridgeMessage,
    parentOrigin: string,
    session: string,
    attachmentId: string,
    providerId: string,
    providerLabel: string,
  ) {
    if (!(message.file instanceof Blob)) throw new Error('Le fichier transmis est absent.');
    if (message.mediaKind !== 'image' && message.mediaKind !== 'video') {
      throw new Error('Le type de média transmis est invalide.');
    }

    const title = typeof message.title === 'string' && message.title.trim()
      ? message.title.trim()
      : message.mediaKind === 'video' ? 'video.mp4' : 'image.png';
    const file = message.file instanceof File
      ? message.file
      : new File([message.file], title, { type: message.file.type });
    const bridge: IntegrationBridge = {
      providerId,
      providerLabel,
      session,
      parentOrigin,
      attachmentId,
      readOnly: message.readOnly === true,
      maximumDocumentBytes: typeof message.maximumDocumentBytes === 'number'
        ? message.maximumDocumentBytes
        : 4_194_304,
    };
    integrationBridgeRef.current = bridge;
    setIntegrationBridge(bridge);
    if (message.exportAudience === 'ai' || message.exportAudience === 'human') {
      setExportAudience(message.exportAudience);
    }
    if (message.exportContainer === 'zip' || message.exportContainer === 'project') {
      setExportContainer(message.exportContainer);
    }
    if (typeof message.includeOriginalVideos === 'boolean') {
      setIncludeOriginalVideosInExport(message.includeOriginalVideos);
    }
    if (isAppLocale(message.locale)) changeLocale(message.locale);

    if (message.mediaKind === 'video') {
      const project = isRecord(message.document)
        ? message.document as unknown as VideoProjectData
        : undefined;
      if (project && (project.version !== 1 || project.kind !== 'video'
        || !Array.isArray(project.annotations))) {
        throw new Error('Le projet vidéo transmis est invalide.');
      }
      loadVideoFile(file, project, true);
    } else {
      const dataUrl = await readAsDataUrl(file);
      const project = isRecord(message.document)
        ? structuredClone(message.document) as unknown as ProjectFile
        : createBlankProject(locale);
      if (project.version !== 1 || !Array.isArray(project.layers)
        || !Array.isArray(project.annotations)) {
        throw new Error('Le projet image transmis est invalide.');
      }
      project.title = project.title || title.replace(/.[^.]+$/, '');
      project.image = { src: dataUrl, name: title };
      const id = createId();
      setTabs([{ id, label: title, kind: 'image', project: structuredClone(project) }]);
      setActiveTabId(id);
      applyProject(project);
      setTool('select');
    }

    setSaveStatus(bridge.readOnly ? t('Viewing ', 'Consultation ') + providerLabel : t('Linked to ', 'Lié à ') + providerLabel + t(' · ready', ' · prêt'));
    showImportNotice(
      bridge.readOnly
        ? t('Media from ', 'Média ') + providerLabel + t(' opened read-only', ' ouvert en consultation')
        : t('Media from ', 'Média ') + providerLabel + t(' ready to annotate', ' prêt à annoter'),
    );
  }

  function sendIntegrationDocument(document: ProjectFile | VideoProjectData) {
    const bridge = integrationBridgeRef.current;
    if (!bridge || !window.opener) return false;
    if (bridge.readOnly) {
      setSaveStatus(t('Read-only', 'Consultation seule'));
      showImportNotice(bridge.providerLabel + t(' does not allow annotation changes', ' ne permet pas de modifier les annotations'));
      return false;
    }

    const clean = structuredClone(document);
    if (!('kind' in clean)) {
      clean.image = clean.image
        ? { ...clean.image, src: bridge.providerId + '-attachment:' + bridge.attachmentId }
        : { src: bridge.providerId + '-attachment:' + bridge.attachmentId, name: imageName };
    }
    const size = new Blob([JSON.stringify(clean)]).size;
    if (size > bridge.maximumDocumentBytes) {
      setSaveStatus(t('Document for ', 'Document ') + bridge.providerLabel + t(' is too large', ' trop volumineux'));
      showImportNotice(t('Reduce reference captures before saving', 'Réduisez les captures de référence avant de sauver'));
      return false;
    }

    window.opener.postMessage({
      source: 'cyannota',
      type: 'save-annotations',
      protocol: 'cyannota.integration',
      protocolVersion: 1,
      session: bridge.session,
      attachmentId: bridge.attachmentId,
      document: clean,
      exportPreferences: {
        audience: exportAudience,
        container: exportContainer,
        includeOriginalVideos: includeOriginalVideosInExport,
        locale,
      },
    }, bridge.parentOrigin);
    setSaveStatus(t('Saving to ', 'Enregistrement dans ') + bridge.providerLabel + '…');
    return true;
  }

  function persistActiveImageTab(
    patch: Partial<Pick<ProjectFile, 'globalInstructions' | 'annotations'>>,
  ) {
    setTabs((items) => items.map((tab) =>
      tab.id === activeTabId && tab.kind === 'image'
        ? { ...tab, project: { ...tab.project, ...patch } }
        : tab,
    ));
  }

  function updateGlobalInstructions(value: string) {
    globalInstructionsRef.current = value;
    setGlobalInstructions(value);
    persistActiveImageTab({ globalInstructions: value });
  }

  function projectData(): ProjectFile {
    return {
      version: 1,
      title: projectTitle,
      globalInstructions: globalInstructionsRef.current,
      image: imageSource ? { src: imageSource, name: imageName } : null,
      layers,
      annotations: annotationsRef.current,
    };
  }

  function changeLocale(nextLocale: AppLocale) {
    if (nextLocale === locale) return;
    setLocale(nextLocale);
    setProjectTitle((current) =>
      current === 'Interface corrections' || current === 'Corrections interface'
        ? translate(nextLocale, 'Interface corrections', 'Corrections interface')
        : current,
    );
    setLayers((items) => items.map((layer) => ({
      ...layer,
      name: layer.name === 'UI corrections' || layer.name === 'Corrections UI'
        ? translate(nextLocale, 'UI corrections', 'Corrections UI')
        : layer.name,
    })));
    setSaveStatus((current) =>
      current === 'Ready' || current === 'Prêt'
        ? translate(nextLocale, 'Ready', 'Prêt')
        : current,
    );
    if (exportOpen) {
      setExportPrompt(
        activeTab?.kind === 'video'
          ? buildVideoPrompt(createVideoDeliveryProject(
              activeTab.project,
              includeOriginalVideosInExport,
              preserveGifFormatInExport && isGifFile(activeTab.file) ? 'gif' : 'mp4',
            ), nextLocale)
          : buildPrompt(projectData(), nextLocale),
      );
    }
  }

  function applyProject(project: ProjectFile) {
    if (project.version !== 1 || !Array.isArray(project.layers) || !Array.isArray(project.annotations)) {
      throw new Error('Format de projet CyAnnota invalide');
    }
    setProjectTitle(project.title || t('Interface corrections', 'Corrections interface'));
    globalInstructionsRef.current = project.globalInstructions || '';
    setGlobalInstructions(globalInstructionsRef.current);
    setLayers(project.layers.length ? project.layers : initialLayers(locale));
    setActiveLayerId(project.layers[0]?.id || 'ui');
    setAnnotations(project.annotations);
    annotationsRef.current = project.annotations;
    setImageSource(project.image?.src || null);
    setImageName(project.image?.name || t('No capture', 'Aucune capture'));
    setSelectedId(null);
    setPast([]);
    setFuture([]);
    setPolygonPoints([]);
    cutImageCache.current.clear();
  }

  function saveActiveTab(
    items: BoardTab[],
    snapshot: ProjectFile = structuredClone(projectData()),
  ) {
    return items.map((tab) =>
      tab.id === activeTabId && tab.kind === 'image'
        ? {
            ...tab,
            label: snapshot.image?.name || snapshot.title || 'Nouvelle image',
            project: snapshot,
          }
        : tab,
    );
  }

  function activateTab(tabId: string) {
    if (tabId === activeTabId) return;
    const snapshot = structuredClone(projectData());
    const nextTabs = saveActiveTab(tabs, snapshot);
    const target = nextTabs.find((tab) => tab.id === tabId);
    if (!target) return;
    setTabs(nextTabs);
    setActiveTabId(tabId);
    if (target.kind === 'image') {
      applyProject(structuredClone(target.project));
      setTool('select');
    }
  }

  function createTab(project: ProjectFile = createBlankProject(locale), label = t('New image', 'Nouvelle image')) {
    const id = createId();
    const snapshot = structuredClone(projectData());
    const nextTab: ImageBoardTab = {
      id,
      label,
      kind: 'image',
      project: structuredClone(project),
    };
    setTabs([...saveActiveTab(tabs, snapshot), nextTab]);
    setActiveTabId(id);
    applyProject(structuredClone(project));
    setTool('select');
  }

  function closeTab(tabId: string) {
    if (tabs.length === 1) {
      const project = createBlankProject(locale);
      setTabs([{ id: tabs[0].id, label: t('New image', 'Nouvelle image'), kind: 'image', project }]);
      setActiveTabId(tabs[0].id);
      applyProject(project);
      return;
    }

    if (tabId !== activeTabId) {
      setTabs((items) => items.filter((tab) => tab.id !== tabId));
      return;
    }

    const currentIndex = tabs.findIndex((tab) => tab.id === tabId);
    const target = tabs[currentIndex + 1] || tabs[currentIndex - 1];
    setTabs((items) => items.filter((tab) => tab.id !== tabId));
    setActiveTabId(target.id);
    if (target.kind === 'image') {
      applyProject(structuredClone(target.project));
      setTool('select');
    }
  }

  useEffect(() => {
    const snapshot: ProjectFile = {
      version: 1,
      title: projectTitle,
      globalInstructions,
      image: imageSource ? { src: imageSource, name: imageName } : null,
      layers,
      annotations,
    };
    const syncFrame = window.requestAnimationFrame(() => {
      setTabs((items) =>
        items.map((tab) =>
          tab.id === activeTabId && tab.kind === 'image'
            ? {
                ...tab,
                label: snapshot.image?.name || snapshot.title || (locale === 'fr' ? 'Nouvelle image' : 'New image'),
                project: snapshot,
              }
            : tab,
        ),
      );
    });
    return () => window.cancelAnimationFrame(syncFrame);
  }, [
    activeTabId,
    imageSource,
    imageName,
    layers,
    annotations,
    projectTitle,
    globalInstructions,
    locale,
  ]);

  useEffect(() => {
    readDraft().then((project) => setHasLocalDraft(Boolean(project?.image))).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!imageSource) {
      imageRef.current = null;
      const resetFrame = window.requestAnimationFrame(() => setImageSize({ width: 0, height: 0 }));
      return () => window.cancelAnimationFrame(resetFrame);
    }
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
      window.requestAnimationFrame(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const nextZoom = Math.min(
          1,
          Math.max(
            0.1,
            Math.min(
              (stage.clientWidth - 76) / image.naturalWidth,
              (stage.clientHeight - 76) / image.naturalHeight,
            ),
          ),
        );
        const nextPan = {
          x: (stage.clientWidth - image.naturalWidth * nextZoom) / 2,
          y: (stage.clientHeight - image.naturalHeight * nextZoom) / 2,
        };
        zoomRef.current = nextZoom;
        panRef.current = nextPan;
        setZoom(nextZoom);
        setPan(nextPan);
      });
    };
    image.src = imageSource;
  }, [imageSource]);

  useEffect(() => {
    for (const annotation of annotations) {
      if ((annotation.type !== 'cut' && annotation.type !== 'resize') || cutImageCache.current.has(annotation.id)) continue;
      const cutImage = new Image();
      cutImage.onload = () => {
        cutImageCache.current.set(annotation.id, cutImage);
        setRenderTick((value) => value + 1);
      };
      cutImage.src = annotation.imageData;
    }
  }, [annotations]);

  useEffect(() => {
    if (!imageSource || integrationBridgeRef.current) return;
    setSaveStatus(t('Saving…', 'Enregistrement…'));
    const timeout = window.setTimeout(() => {
      storeDraft(projectData())
        .then(() => {
          setSaveStatus(t('Saved locally', 'Enregistré localement'));
          setHasLocalDraft(true);
        })
        .catch(() => setSaveStatus(t('Manual save recommended', 'Sauvegarde manuelle conseillée')));
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [imageSource, imageName, annotations, layers, projectTitle, globalInstructions]);

  function unitSize() {
    return Math.max(1, Math.min(3.2, imageSize.width / 1100));
  }

  function drawArrow(
    context: CanvasRenderingContext2D,
    start: Point,
    end: Point,
    color: string,
    lineWidth: number,
  ) {
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const head = lineWidth * 5;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = 'round';
    context.stroke();
    context.beginPath();
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
    context.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fillStyle = color;
    context.fill();
  }

  function drawBadge(
    context: CanvasRenderingContext2D,
    annotation: Annotation,
    index: number,
    unit: number,
  ) {
    const bounds = annotationBounds(annotation);
    const radius = 11 * unit;
    const centerX = bounds.x - radius * 0.25;
    const centerY = bounds.y - radius * 0.25;
    context.save();
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.fillStyle = annotation.color;
    context.fill();
    context.lineWidth = 2 * unit;
    context.strokeStyle = '#171513';
    context.stroke();
    context.fillStyle = '#171513';
    context.font = '800 ' + 10 * unit + 'px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(index + 1).padStart(2, '0'), centerX, centerY + unit * 0.4);
    context.restore();
  }

  function drawAnnotation(
    context: CanvasRenderingContext2D,
    annotation: Annotation,
    index: number,
    showSelection: boolean,
    renderWidth = imageSize.width,
    cutImages = cutImageCache.current,
    selectionId: string | null = selectedId,
    sourceAnnotations = annotations,
  ) {
    const unit = Math.max(1, Math.min(3.2, renderWidth / 1100));
    const lineWidth = 2.4 * unit;
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';

    if (annotation.type === 'rect') {
      context.strokeStyle = annotation.color;
      context.lineWidth = lineWidth;
      context.strokeRect(annotation.x, annotation.y, annotation.w, annotation.h);
      context.fillStyle = annotation.color + '18';
      context.fillRect(annotation.x, annotation.y, annotation.w, annotation.h);
    }

    if (annotation.type === 'frame') {
      context.fillStyle = annotation.color + '10';
      context.fillRect(annotation.x, annotation.y, annotation.w, annotation.h);
      context.strokeStyle = annotation.color;
      context.lineWidth = lineWidth;
      context.setLineDash([10 * unit, 6 * unit]);
      context.strokeRect(annotation.x, annotation.y, annotation.w, annotation.h);
      context.setLineDash([]);
      context.strokeStyle = annotation.color + '66';
      context.lineWidth = unit;
      context.strokeRect(
        annotation.x + 6 * unit,
        annotation.y + 6 * unit,
        Math.max(0, annotation.w - 12 * unit),
        Math.max(0, annotation.h - 12 * unit),
      );
      const childCount = sourceAnnotations.filter((item) => item.groupId === annotation.id).length;
      context.font = '800 ' + 9 * unit + 'px Arial';
      const frameLabel = t('FRAME · ', 'CADRE · ') + childCount + (childCount === 1 ? t(' ITEM', ' ÉLÉMENT') : t(' ITEMS', ' ÉLÉMENTS'));
      const frameLabelWidth = context.measureText(frameLabel).width + 16 * unit;
      context.fillStyle = annotation.color;
      context.fillRect(annotation.x, annotation.y - 21 * unit, frameLabelWidth, 21 * unit);
      context.fillStyle = '#171513';
      context.textBaseline = 'middle';
      context.fillText(frameLabel, annotation.x + 8 * unit, annotation.y - 10 * unit);
    }

    if (annotation.type === 'shape') {
      context.strokeStyle = annotation.color;
      context.fillStyle = annotation.fillColor + '30';
      context.lineWidth = lineWidth;
      if (annotation.shape === 'ellipse') {
        context.beginPath();
        context.ellipse(
          annotation.x + annotation.w / 2,
          annotation.y + annotation.h / 2,
          Math.abs(annotation.w / 2),
          Math.abs(annotation.h / 2),
          0,
          0,
          Math.PI * 2,
        );
        context.fill();
        context.stroke();
      } else if (annotation.shape === 'line') {
        context.beginPath();
        context.moveTo(annotation.x, annotation.y);
        context.lineTo(annotation.x + annotation.w, annotation.y + annotation.h);
        context.stroke();
      } else {
        context.fillRect(annotation.x, annotation.y, annotation.w, annotation.h);
        context.strokeRect(annotation.x, annotation.y, annotation.w, annotation.h);
      }
    }

    if (annotation.type === 'delete') {
      const deleteColor = '#ff453a';
      context.fillStyle = deleteColor + '26';
      context.fillRect(annotation.x, annotation.y, annotation.w, annotation.h);
      context.strokeStyle = deleteColor;
      context.lineWidth = 2.5 * unit;
      context.setLineDash([9 * unit, 5 * unit]);
      context.strokeRect(annotation.x, annotation.y, annotation.w, annotation.h);
      context.setLineDash([]);
      context.beginPath();
      context.moveTo(annotation.x, annotation.y);
      context.lineTo(annotation.x + annotation.w, annotation.y + annotation.h);
      context.moveTo(annotation.x + annotation.w, annotation.y);
      context.lineTo(annotation.x, annotation.y + annotation.h);
      context.stroke();
      context.font = '900 ' + 10 * unit + 'px Arial';
      const deleteLabel = 'SUPPRIMER';
      const deleteWidth = context.measureText(deleteLabel).width + 16 * unit;
      context.fillStyle = deleteColor;
      context.fillRect(annotation.x, annotation.y, deleteWidth, 22 * unit);
      context.fillStyle = '#ffffff';
      context.textBaseline = 'middle';
      context.fillText(deleteLabel, annotation.x + 8 * unit, annotation.y + 11 * unit);
    }

    if (annotation.type === 'arrow') {
      drawArrow(
        context,
        { x: annotation.x1, y: annotation.y1 },
        { x: annotation.x2, y: annotation.y2 },
        annotation.color,
        lineWidth,
      );
    }

    if (annotation.type === 'text') {
      const label = annotation.description.trim() || 'Ajouter une explication';
      context.font = '700 ' + 12 * unit + 'px Arial';
      const textWidth = Math.min(320 * unit, context.measureText(label).width + 24 * unit);
      context.fillStyle = '#191817eF';
      context.strokeStyle = annotation.color;
      context.lineWidth = 1.5 * unit;
      context.beginPath();
      context.roundRect(annotation.x, annotation.y - 27 * unit, textWidth, 29 * unit, 7 * unit);
      context.fill();
      context.stroke();
      context.save();
      context.beginPath();
      context.rect(annotation.x + 8 * unit, annotation.y - 25 * unit, textWidth - 16 * unit, 25 * unit);
      context.clip();
      context.fillStyle = '#ffffff';
      context.textBaseline = 'middle';
      context.fillText(label, annotation.x + 12 * unit, annotation.y - 12.5 * unit);
      context.restore();
    }

    if (annotation.type === 'draw') {
      if (annotation.points.length > 1) {
        context.beginPath();
        context.moveTo(annotation.points[0].x, annotation.points[0].y);
        for (const point of annotation.points.slice(1)) context.lineTo(point.x, point.y);
        context.strokeStyle = annotation.color;
        context.lineWidth = lineWidth;
        context.stroke();
      }
    }

    if (annotation.type === 'color') {
      context.beginPath();
      context.arc(annotation.x, annotation.y, 9 * unit, 0, Math.PI * 2);
      context.fillStyle = annotation.sampledColor;
      context.fill();
      context.strokeStyle = '#ffffff';
      context.lineWidth = 2 * unit;
      context.stroke();
      context.beginPath();
      context.arc(annotation.x, annotation.y, 14 * unit, 0, Math.PI * 2);
      context.strokeStyle = annotation.color;
      context.lineWidth = 1.5 * unit;
      context.stroke();

      const swatchY = annotation.y;
      const oldX = annotation.x + 25 * unit;
      const newX = annotation.x + 58 * unit;
      context.fillStyle = annotation.sampledColor;
      context.fillRect(oldX, swatchY - 9 * unit, 18 * unit, 18 * unit);
      context.strokeStyle = '#ffffff88';
      context.lineWidth = unit;
      context.strokeRect(oldX, swatchY - 9 * unit, 18 * unit, 18 * unit);
      drawArrow(
        context,
        { x: oldX + 20 * unit, y: swatchY },
        { x: newX - 3 * unit, y: swatchY },
        annotation.color,
        unit,
      );
      context.fillStyle = annotation.replacementColor;
      context.fillRect(newX, swatchY - 9 * unit, 18 * unit, 18 * unit);
      context.strokeRect(newX, swatchY - 9 * unit, 18 * unit, 18 * unit);
    }

    if (annotation.type === 'cut' || annotation.type === 'resize') {
      const sourceW = annotation.type === 'resize' ? annotation.sourceW : annotation.w;
      const sourceH = annotation.type === 'resize' ? annotation.sourceH : annotation.h;
      const moved = Math.abs(annotation.x - annotation.sourceX) > 1 || Math.abs(annotation.y - annotation.sourceY) > 1;
      const resized = annotation.type === 'resize' &&
        (Math.abs(annotation.w - annotation.sourceW) > 1 || Math.abs(annotation.h - annotation.sourceH) > 1);
      const destinationPolygon = annotation.type === 'cut'
        ? annotation.polygon?.map((point) => ({
            x: annotation.x + point.x - annotation.sourceX,
            y: annotation.y + point.y - annotation.sourceY,
          }))
        : undefined;

      if (moved || resized) {
        context.save();
        context.fillStyle = annotation.color + '1f';
        context.strokeStyle = annotation.color + 'bb';
        context.lineWidth = 1.5 * unit;
        context.setLineDash([7 * unit, 5 * unit]);
        if (annotation.type === 'cut' && annotation.polygon?.length) {
          context.beginPath();
          context.moveTo(annotation.polygon[0].x, annotation.polygon[0].y);
          for (const point of annotation.polygon.slice(1)) context.lineTo(point.x, point.y);
          context.closePath();
          context.fill();
          context.stroke();
        } else {
          context.fillRect(annotation.sourceX, annotation.sourceY, sourceW, sourceH);
          context.strokeRect(annotation.sourceX, annotation.sourceY, sourceW, sourceH);
        }
        context.restore();
        drawArrow(
          context,
          { x: annotation.sourceX + sourceW / 2, y: annotation.sourceY + sourceH / 2 },
          { x: annotation.x + annotation.w / 2, y: annotation.y + annotation.h / 2 },
          annotation.color + 'cc',
          1.5 * unit,
        );
      }

      const cutImage = cutImages.get(annotation.id);
      if (cutImage) context.drawImage(cutImage, annotation.x, annotation.y, annotation.w, annotation.h);
      context.strokeStyle = annotation.color;
      context.lineWidth = lineWidth;
      if (destinationPolygon?.length) {
        context.beginPath();
        context.moveTo(destinationPolygon[0].x, destinationPolygon[0].y);
        for (const point of destinationPolygon.slice(1)) context.lineTo(point.x, point.y);
        context.closePath();
        context.stroke();
      } else {
        context.strokeRect(annotation.x, annotation.y, annotation.w, annotation.h);
      }
      if (annotation.type === 'resize') {
        const resizeLabel = Math.round(sourceW) + '×' + Math.round(sourceH) + ' → ' + Math.round(annotation.w) + '×' + Math.round(annotation.h);
        context.font = '800 ' + 9 * unit + 'px Arial';
        const labelWidth = context.measureText(resizeLabel).width + 14 * unit;
        context.fillStyle = annotation.color;
        context.fillRect(annotation.x, annotation.y + annotation.h, labelWidth, 20 * unit);
        context.fillStyle = '#171513';
        context.textBaseline = 'middle';
        context.fillText(resizeLabel, annotation.x + 7 * unit, annotation.y + annotation.h + 10 * unit);
      }
    }

    drawBadge(context, annotation, index, unit);

    if (showSelection && annotation.id === selectionId) {
      const bounds = annotationBounds(annotation);
      context.setLineDash([6 * unit, 4 * unit]);
      context.strokeStyle = '#ffffff';
      context.lineWidth = 1.3 * unit;
      context.strokeRect(bounds.x - 5 * unit, bounds.y - 5 * unit, bounds.w + 10 * unit, bounds.h + 10 * unit);
      if (annotation.type === 'resize') {
        const handleSize = 11 * unit;
        context.setLineDash([]);
        context.fillStyle = '#ffffff';
        context.fillRect(bounds.x + bounds.w - handleSize / 2, bounds.y + bounds.h - handleSize / 2, handleSize, handleSize);
        context.strokeStyle = annotation.color;
        context.strokeRect(bounds.x + bounds.w - handleSize / 2, bounds.y + bounds.h - handleSize / 2, handleSize, handleSize);
      }
    }
    context.restore();
  }

  function drawDraft(context: CanvasRenderingContext2D, value: Draft) {
    const unit = unitSize();
    const color = value.tool === 'delete' ? '#ff453a' : activeLayer?.color || '#ff5c49';
    const lineWidth = 2 * unit;
    const bounds = normalizeRect(value.start, value.end);
    context.save();
    context.setLineDash(value.tool === 'draw' ? [] : [7 * unit, 5 * unit]);
    context.strokeStyle = color;
    context.fillStyle = color + '1f';
    context.lineWidth = lineWidth;

    if (
      value.tool === 'rect' ||
      value.tool === 'cut' ||
      value.tool === 'frame' ||
      value.tool === 'resize' ||
      value.tool === 'delete'
    ) {
      context.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
      context.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
    }
    if (value.tool === 'delete') {
      context.beginPath();
      context.moveTo(bounds.x, bounds.y);
      context.lineTo(bounds.x + bounds.w, bounds.y + bounds.h);
      context.moveTo(bounds.x + bounds.w, bounds.y);
      context.lineTo(bounds.x, bounds.y + bounds.h);
      context.stroke();
    }
    if (value.tool === 'shape') {
      context.beginPath();
      context.ellipse(
        bounds.x + bounds.w / 2,
        bounds.y + bounds.h / 2,
        bounds.w / 2,
        bounds.h / 2,
        0,
        0,
        Math.PI * 2,
      );
      context.fill();
      context.stroke();
    }
    if (value.tool === 'arrow') drawArrow(context, value.start, value.end, color, lineWidth);
    if (value.tool === 'draw' && value.points.length > 1) {
      context.beginPath();
      context.moveTo(value.points[0].x, value.points[0].y);
      for (const point of value.points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
    context.restore();
  }

  function drawPolygonDraft(context: CanvasRenderingContext2D, points: Point[]) {
    if (!points.length) return;
    const unit = unitSize();
    const color = activeLayer?.color || '#ff5c49';
    context.save();
    context.strokeStyle = color;
    context.fillStyle = color + '18';
    context.lineWidth = 2 * unit;
    context.setLineDash([7 * unit, 5 * unit]);
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    if (points.length > 2) {
      context.closePath();
      context.fill();
    }
    context.stroke();
    for (const point of points) {
      context.beginPath();
      context.arc(point.x, point.y, 5 * unit, 0, Math.PI * 2);
      context.fillStyle = '#171513';
      context.fill();
      context.strokeStyle = color;
      context.setLineDash([]);
      context.stroke();
    }
    context.restore();
  }

  function paintCanvas(
    context: CanvasRenderingContext2D,
    layerIds: Set<string>,
    showSelection = false,
    currentDraft: Draft | null = null,
  ) {
    context.clearRect(0, 0, imageSize.width, imageSize.height);
    if (imageRef.current) {
      context.drawImage(imageRef.current, 0, 0, imageSize.width, imageSize.height);
    }
    annotations.forEach((annotation, index) => {
      if (layerIds.has(annotation.layerId)) drawAnnotation(context, annotation, index, showSelection);
    });
    if (currentDraft) drawDraft(context, currentDraft);
    if (showSelection && polygonPoints.length) drawPolygonDraft(context, polygonPoints);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageSize.width || !imageSize.height) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    paintCanvas(context, visibleLayerIds, true, draft);
  }, [imageSize, annotations, layers, selectedId, draft, polygonPoints, renderTick]);

  function replaceAnnotations(next: Annotation[]) {
    annotationsRef.current = next;
    setAnnotations(next);
  }

  function commitAnnotations(next: Annotation[], before = annotationsRef.current) {
    setPast((items) => [...items, cloneAnnotations(before)].slice(-50));
    setFuture([]);
    replaceAnnotations(next);
    persistActiveImageTab({ annotations: next });
  }

  function updateAnnotation(id: string, patch: Partial<Annotation>) {
    const next = annotationsRef.current.map((annotation) =>
      annotation.id === id ? ({ ...annotation, ...patch } as Annotation) : annotation);
    replaceAnnotations(next);
    persistActiveImageTab({ annotations: next });
  }

  function undo() {
    if (!past.length) return;
    const previous = past[past.length - 1];
    setFuture((items) => [cloneAnnotations(annotationsRef.current), ...items].slice(0, 50));
    replaceAnnotations(previous);
    persistActiveImageTab({ annotations: previous });
    setPast((items) => items.slice(0, -1));
    setSelectedId(null);
  }

  function redo() {
    if (!future.length) return;
    const next = future[0];
    setPast((items) => [...items, cloneAnnotations(annotationsRef.current)].slice(-50));
    replaceAnnotations(next);
    persistActiveImageTab({ annotations: next });
    setFuture((items) => items.slice(1));
    setSelectedId(null);
  }

  function deleteSelected() {
    if (!selectedId) return;
    commitAnnotations(annotationsRef.current.filter((annotation) => annotation.id !== selectedId));
    setSelectedId(null);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.code === 'Space' && imageSource) {
        event.preventDefault();
        spaceHeldRef.current = true;
        setIsSpaceHeld(true);
      }
      if (event.key === 'Escape' && polygonPoints.length) {
        event.preventDefault();
        setPolygonPoints([]);
      }
      if (event.key === 'Enter' && polygonPoints.length >= 3) {
        event.preventDefault();
        finishPolygonCut();
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault();
        deleteSelected();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.code !== 'Space') return;
      spaceHeldRef.current = false;
      setIsSpaceHeld(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  });

  function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, ((event.clientX - bounds.left) / bounds.width) * canvas.width)),
      y: Math.max(0, Math.min(canvas.height, ((event.clientY - bounds.top) / bounds.height) * canvas.height)),
    };
  }

  function changeZoom(nextValue: number, clientX?: number, clientY?: number) {
    const nextZoom = Math.max(0.1, Math.min(5, nextValue));
    const stage = stageRef.current;
    if (!stage || !imageSize.width || !imageSize.height) {
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      return;
    }

    const stageBounds = stage.getBoundingClientRect();
    const focusX = (clientX ?? stageBounds.left + stage.clientWidth / 2) - stageBounds.left;
    const focusY = (clientY ?? stageBounds.top + stage.clientHeight / 2) - stageBounds.top;
    const currentZoom = zoomRef.current;
    const currentPan = panRef.current;
    const imageX = (focusX - currentPan.x) / currentZoom;
    const imageY = (focusY - currentPan.y) / currentZoom;
    const nextPan = {
      x: focusX - imageX * nextZoom,
      y: focusY - imageY * nextZoom,
    };

    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
  }

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    function onWheel(event: WheelEvent) {
      if (!imageSource) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0015);
      changeZoom(zoomRef.current * factor, event.clientX, event.clientY);
    }
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [activeTabId, imageSource, imageSize.width, imageSize.height]);

  function hitAnnotation(point: Point) {
    const tolerance = 12 / Math.max(zoom, 0.1);
    return [...annotationsRef.current].reverse().find((annotation) => {
      if (!visibleLayerIds.has(annotation.layerId)) return false;
      if (annotation.type === 'arrow') {
        return pointSegmentDistance(
          point,
          { x: annotation.x1, y: annotation.y1 },
          { x: annotation.x2, y: annotation.y2 },
        ) <= tolerance;
      }
      const bounds = annotationBounds(annotation);
      return (
        point.x >= bounds.x - tolerance &&
        point.x <= bounds.x + bounds.w + tolerance &&
        point.y >= bounds.y - tolerance &&
        point.y <= bounds.y + bounds.h + tolerance
      );
    });
  }
  function isResizeHandle(point: Point, annotation: ResizeAnnotation) {
    const tolerance = 18 / Math.max(zoomRef.current, 0.1);
    const handleX = annotation.x + annotation.w;
    const handleY = annotation.y + annotation.h;
    return Math.abs(point.x - handleX) <= tolerance && Math.abs(point.y - handleY) <= tolerance;
  }


  function groupAtPoint(point?: Point) {
    if (!point) return undefined;
    return [...annotationsRef.current]
      .reverse()
      .find((annotation): annotation is FrameAnnotation => {
        if (annotation.type !== 'frame') return false;
        return (
          point.x >= annotation.x &&
          point.x <= annotation.x + annotation.w &&
          point.y >= annotation.y &&
          point.y <= annotation.y + annotation.h
        );
      })?.id;
  }

  function baseAnnotation(
    category: Category,
    description: string,
    point?: Point,
  ): AnnotationBase {
    return {
      id: createId(),
      layerId: activeLayerId,
      color: activeLayer?.color || '#ff5c49',
      description,
      category,
      references: [],
      createdAt: Date.now(),
      groupId: groupAtPoint(point),
    };
  }

  function addAnnotation(annotation: Annotation) {
    commitAnnotations([...annotationsRef.current, annotation]);
    setSelectedId(annotation.id);
  }

  function sampleImageColor(point: Point) {
    const image = imageRef.current;
    if (!image) return '#000000';
    const sampleCanvas = colorSampleCanvasRef.current || document.createElement('canvas');
    colorSampleCanvasRef.current = sampleCanvas;
    sampleCanvas.width = 1;
    sampleCanvas.height = 1;
    const context = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) return '#000000';
    const sampleX = Math.max(0, Math.min(image.naturalWidth - 1, Math.floor(point.x)));
    const sampleY = Math.max(0, Math.min(image.naturalHeight - 1, Math.floor(point.y)));
    context.clearRect(0, 0, 1, 1);
    context.drawImage(image, sampleX, sampleY, 1, 1, 0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return (
      '#' +
      [red, green, blue]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
    );
  }

  function colorInstruction(sampledColor: string) {
    return 'Remplacer la couleur ' + sampledColor + ' par la couleur choisie.';
  }

  function moveAnnotationAndRefreshColor(annotation: Annotation, dx: number, dy: number) {
    const moved = moveAnnotation(annotation, dx, dy);
    if (moved.type !== 'color') return moved;
    const sampledColor = sampleImageColor({ x: moved.x, y: moved.y });
    const hasAutomaticDescription =
      /^Remplacer la couleur #[0-9a-f]{6} par la couleur choisie\.$/i.test(
        annotation.description.trim(),
      );
    return {
      ...moved,
      sampledColor,
      description: hasAutomaticDescription
        ? colorInstruction(sampledColor)
        : moved.description,
    };
  }

  function createColorAnnotation(point: Point) {
    const sampledColor = sampleImageColor(point);
    const base = baseAnnotation(
      'modifier',
      colorInstruction(sampledColor),
      point,
    );
    addAnnotation({
      ...base,
      type: 'color',
      x: point.x,
      y: point.y,
      sampledColor,
      replacementColor: '#ffffff',
    });
    showImportNotice(t('Color sampled: ', 'Couleur capturée : ') + sampledColor);
    setTool('select');
  }

  function finishPolygonCut(points: Point[] = polygonPoints) {
    if (!imageRef.current || points.length < 3) return;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const sourceX = Math.max(0, Math.floor(Math.min(...xs)));
    const sourceY = Math.max(0, Math.floor(Math.min(...ys)));
    const width = Math.max(1, Math.ceil(Math.max(...xs)) - sourceX);
    const height = Math.max(1, Math.ceil(Math.max(...ys)) - sourceY);
    const cutCanvas = document.createElement('canvas');
    cutCanvas.width = width;
    cutCanvas.height = height;
    const context = cutCanvas.getContext('2d');
    if (!context) return;
    context.save();
    context.beginPath();
    context.moveTo(points[0].x - sourceX, points[0].y - sourceY);
    for (const point of points.slice(1)) {
      context.lineTo(point.x - sourceX, point.y - sourceY);
    }
    context.closePath();
    context.clip();
    context.drawImage(
      imageRef.current,
      sourceX,
      sourceY,
      width,
      height,
      0,
      0,
      width,
      height,
    );
    context.restore();

    const base = baseAnnotation(
      'deplacer',
      t('Move this cutout along its polygon outline.', 'Déplacer cet élément découpé selon le contour polygonal.'),
      points[0],
    );
    const annotation: CutAnnotation = {
      ...base,
      type: 'cut',
      sourceX,
      sourceY,
      x: sourceX,
      y: sourceY,
      w: width,
      h: height,
      imageData: cutCanvas.toDataURL('image/png'),
      polygon: points,
    };
    addAnnotation(annotation);
    setPolygonPoints([]);
    setTool('select');
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!imageSource || ![0, 1, 2].includes(event.button)) return;
    if (event.button === 2) event.preventDefault();
    const point = canvasPoint(event);

    if (event.button === 0 && tool === 'polycut') {
      const firstPoint = polygonPoints[0];
      const closesOnFirstPoint =
        polygonPoints.length >= 3 &&
        firstPoint &&
        Math.hypot(point.x - firstPoint.x, point.y - firstPoint.y) <= 14 / Math.max(zoom, 0.1);
      if ((event.detail >= 2 && polygonPoints.length >= 3) || closesOnFirstPoint) {
        finishPolygonCut(polygonPoints);
      } else {
        setPolygonPoints((items) => [...items, point]);
      }
      return;
    }

    if (event.button === 0 && tool === 'eyedropper') {
      createColorAnnotation(point);
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);

    if (tool === 'pan' || event.button === 1 || event.button === 2 || spaceHeldRef.current) {
      dragRef.current = {
        kind: 'pan',
        clientX: event.clientX,
        clientY: event.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
      setIsPanning(true);
      return;
    }

    if (tool === 'select') {
      const found = hitAnnotation(point);
      setSelectedId(found?.id || null);
      if (found) {
        const before = cloneAnnotations(annotationsRef.current);
        if (found.type === 'resize' && isResizeHandle(point, found)) {
          dragRef.current = {
            kind: 'resize', id: found.id, start: point,
            original: structuredClone(found), before,
          };
        } else {
          dragRef.current = {
            kind: 'move', id: found.id, start: point,
            original: structuredClone(found), before,
          };
        }
      }
      return;
    }

    if (tool === 'text') {
      const base = baseAnnotation('modifier', t('Write your message linked to this area here.', 'Écris ici ton message lié à cette zone.'), point);
      addAnnotation({ ...base, type: 'text', x: point.x, y: point.y });
      setTool('select');
      return;
    }

    if (tool === 'polycut' || tool === 'eyedropper') {
      return;
    }
    const nextDraft: Draft = { tool, start: point, end: point, points: [point] };
    dragRef.current = { kind: 'create', draft: nextDraft };
    setDraft(nextDraft);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) return;

    if (drag.kind === 'pan') {
      const nextPan = {
        x: drag.panX + (event.clientX - drag.clientX),
        y: drag.panY + (event.clientY - drag.clientY),
      };
      panRef.current = nextPan;
      setPan(nextPan);
      return;
    }

    const point = canvasPoint(event);

    if (drag.kind === 'resize') {
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      const ratio = drag.original.sourceW / Math.max(1, drag.original.sourceH);
      let width = Math.max(8, drag.original.w + dx);
      let height = Math.max(8, drag.original.h + dy);
      if (drag.original.lockAspectRatio) {
        if (Math.abs(dx) >= Math.abs(dy)) height = width / ratio;
        else width = height * ratio;
      }
      replaceAnnotations(
        annotationsRef.current.map((annotation) =>
          annotation.id === drag.id
            ? { ...drag.original, w: Math.round(width), h: Math.round(height) }
            : annotation,
        ),
      );
      return;
    }

    if (drag.kind === 'move') {
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      replaceAnnotations(
        annotationsRef.current.map((annotation) => {
          if (annotation.id === drag.id) return moveAnnotationAndRefreshColor(drag.original, dx, dy);
          if (drag.original.type === 'frame' && annotation.groupId === drag.original.id) {
            const originalChild = drag.before.find((item) => item.id === annotation.id);
            return originalChild ? moveAnnotationAndRefreshColor(originalChild, dx, dy) : annotation;
          }
          return annotation;
        }),
      );
      return;
    }

    drag.draft.end = point;
    if (drag.draft.tool === 'draw') drag.draft.points = [...drag.draft.points, point];
    setDraft({ ...drag.draft, points: [...drag.draft.points] });
  }

  function handlePointerMoveEnd(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDraft(null);

    if (drag.kind === 'pan') {
      setIsPanning(false);
      return;
    }

    if (drag.kind === 'move' || drag.kind === 'resize') {
      setPast((items) => [...items, drag.before].slice(-50));
      setFuture([]);
      persistActiveImageTab({ annotations: annotationsRef.current });
      return;
    }

    const value = drag.draft;
    const bounds = normalizeRect(value.start, value.end);
    if (value.tool !== 'draw' && (bounds.w < 5 || bounds.h < 5)) return;

    if (value.tool === 'frame') {
      const base = baseAnnotation(
        'modifier',
        '',
      );
      addAnnotation({ ...base, type: 'frame', ...bounds, groupId: undefined });
    }

    if (value.tool === 'shape') {
      const base = baseAnnotation(
        'ajouter',
        t('Add this shape to the linked frame.', 'Ajouter cette forme dans le cadre associé.'),
        value.start,
      );
      addAnnotation({
        ...base,
        type: 'shape',
        shape: 'ellipse',
        fillColor: activeLayer?.color || '#ff5c49',
        ...bounds,
      });
    }

    if (value.tool === 'delete') {
      const base = baseAnnotation(
        'supprimer',
        t('Delete every item inside this area.', 'Supprimer tous les éléments présents dans cette zone.'),
        value.start,
      );
      addAnnotation({ ...base, type: 'delete', ...bounds, color: '#ff453a' });
    }

    if (value.tool === 'rect') {
      const base = baseAnnotation('modifier', t('Describe precisely what should change in this area.', 'Décris précisément ce qui doit changer dans cette zone.'), value.start);
      addAnnotation({ ...base, type: 'rect', ...bounds });
    }

    if (value.tool === 'arrow') {
      const base = baseAnnotation('modifier', t('Describe the correction indicated by this arrow.', 'Décris la correction indiquée par cette flèche.'), value.start);
      addAnnotation({
        ...base,
        type: 'arrow',
        x1: value.start.x,
        y1: value.start.y,
        x2: value.end.x,
        y2: value.end.y,
      });
    }

    if (value.tool === 'draw' && value.points.length > 1) {
      const base = baseAnnotation('modifier', t('Describe the correction drawn on the capture.', 'Décris la correction dessinée sur la capture.'), value.points[0]);
      addAnnotation({ ...base, type: 'draw', points: value.points });
    }

    if ((value.tool === 'cut' || value.tool === 'resize') && imageRef.current) {
      const source = {
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
        w: Math.max(1, Math.min(Math.round(bounds.w), imageSize.width - Math.round(bounds.x))),
        h: Math.max(1, Math.min(Math.round(bounds.h), imageSize.height - Math.round(bounds.y))),
      };
      const cutCanvas = document.createElement('canvas');
      cutCanvas.width = source.w;
      cutCanvas.height = source.h;
      cutCanvas
        .getContext('2d')
        ?.drawImage(
          imageRef.current,
          source.x,
          source.y,
          source.w,
          source.h,
          0,
          0,
          source.w,
          source.h,
        );
      const imageData = cutCanvas.toDataURL('image/png');
      if (value.tool === 'resize') {
        const base = baseAnnotation(
          'modifier',
          t('Resize this extracted area to the requested dimensions.', 'Redimensionner cette zone extraite aux dimensions demandées.'),
          value.start,
        );
        const annotation: ResizeAnnotation = {
          ...base, type: 'resize', sourceX: source.x, sourceY: source.y,
          sourceW: source.w, sourceH: source.h, x: source.x, y: source.y,
          w: source.w, h: source.h, imageData, lockAspectRatio: true,
        };
        addAnnotation(annotation);
      } else {
        const base = baseAnnotation(
          'deplacer',
          t('Move this item to the indicated new position.', 'Déplacer cet élément vers la nouvelle position indiquée.'),
          value.start,
        );
        const annotation: CutAnnotation = {
          ...base, type: 'cut', sourceX: source.x, sourceY: source.y,
          x: source.x, y: source.y, w: source.w, h: source.h, imageData,
        };
        addAnnotation(annotation);
      }
      setTool('select');
    }
  }

  function showImportNotice(message: string) {
    setImportNotice(message);
    if (importNoticeTimer.current) window.clearTimeout(importNoticeTimer.current);
    importNoticeTimer.current = window.setTimeout(() => setImportNotice(''), 2600);
  }

  function loadVideoFile(file?: File, project?: VideoProjectData, fromIntegration = false) {
    if (!file) return false;
    if (integrationBridgeRef.current && !fromIntegration) {
      showImportNotice(t('The media linked to ', 'Le média lié à ') + integrationBridgeRef.current.providerLabel + t(' cannot be replaced in this session', ' ne peut pas être remplacé dans cette session'));
      return false;
    }
    if (!isVideoMediaFile(file)) return false;

    const videoProject: VideoProjectData = project
      ? structuredClone(project)
      : {
          version: 1,
          kind: 'video',
          title: file.name.replace(/\.[^.]+$/, '') || t('Video corrections', 'Corrections vidéo'),
          videoName: file.name,
          videoType: file.type || 'video/mp4',
          duration: 0,
          sourcePath: 'media/original-' + safeFileName(file.name),
          generalInstructions: '',
          annotations: [],
          frameStops: [],
        };
    const id = createId();
    const nextTab: VideoBoardTab = {
      id,
      label: videoProject.title || file.name,
      kind: 'video',
      file,
      project: videoProject,
    };
    const replaceBlank =
      tabs.length === 1 &&
      activeTab?.kind === 'image' &&
      !imageSource &&
      !activeTab.project.image;

    setTabs((items) => (replaceBlank ? [nextTab] : [...saveActiveTab(items), nextTab]));
    setActiveTabId(id);
    setSelectedId(null);
    setTool('select');
    showImportNotice(replaceBlank ? t('Video opened in the first tab', 'Vidéo ouverte dans le premier onglet') : t('Video opened in a new tab', 'Vidéo ouverte dans un nouvel onglet'));
    return true;
  }

  function updateVideoTab(tabId: string, project: VideoProjectData) {
    setTabs((items) =>
      items.map((tab) =>
        tab.id === tabId && tab.kind === 'video'
          ? { ...tab, label: project.title || project.videoName, project: structuredClone(project) }
          : tab,
      ),
    );
  }

  async function openVideoFrameAsImage(file: File, time: number, videoTitle: string) {
    const dataUrl = await readAsDataUrl(file);
    const project = createBlankProject(locale);
    project.title = file.name.replace(/\.[^.]+$/, '') || t('Video capture', 'Capture vidéo');
    project.globalInstructions =
      t('Capture extracted from video “', 'Capture extraite de la vidéo « ') + videoTitle + t('” at timecode ', ' » au timecode ') +
      formatVideoTime(time) + '.';
    project.image = { src: dataUrl, name: file.name };
    createTab(project, file.name);
    showImportNotice(t('Video capture opened in an image tab', 'Capture vidéo ouverte dans un onglet image'));
  }

  async function loadImageFile(file?: File, source: 'file' | 'clipboard' = 'file') {
    if (integrationBridgeRef.current) {
      showImportNotice(t('The media linked to ', 'Le média lié à ') + integrationBridgeRef.current.providerLabel + t(' cannot be replaced in this session', ' ne peut pas être remplacé dans cette session'));
      return false;
    }
    if (!file) return false;
    if (isGifFile(file)) return loadVideoFile(file);
    if (!isStillImageFile(file)) return false;
    const dataUrl = await readAsDataUrl(file);
    const nextImageName =
      file.name ||
      (source === 'clipboard'
        ? 'capture-collee-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png'
        : 'capture-importee.png');
    const project = createBlankProject(locale);
    project.title = nextImageName.replace(/\.[^.]+$/, '') || 'Corrections interface';
    project.image = { src: dataUrl, name: nextImageName };

    const openedInNewTab = activeTab?.kind === 'video' || Boolean(imageSource);
    if (openedInNewTab) {
      createTab(project, nextImageName);
    } else {
      applyProject(project);
    }

    showImportNotice(
      source === 'clipboard'
        ? openedInNewTab
          ? t('Image pasted into a new tab', 'Image collée dans un nouvel onglet')
          : t('Image pasted from the clipboard', 'Image collée depuis le presse-papiers')
        : openedInNewTab
          ? 'Image ouverte dans un nouvel onglet'
          : t('Image imported by drag and drop', 'Image importée par glisser-déposer'),
    );
    return true;
  }

  async function importClipboardMediaFile(file: File) {
    if (isVideoMediaFile(file)) return loadVideoFile(file);
    if (isStillImageFile(file)) return loadImageFile(file, 'clipboard');
    return false;
  }

  async function pasteMediaFromClipboard() {
    try {
      const desktopItems = await window.cyAnnotaDesktop?.readClipboardFiles?.();
      for (const item of desktopItems || []) {
        const file = new File([item.bytes], item.name, {
          type: item.type || 'application/octet-stream',
          lastModified: Date.now(),
        });
        if (await importClipboardMediaFile(file)) return;
      }

      if (!navigator.clipboard || !('read' in navigator.clipboard)) {
        showImportNotice(t('Use Ctrl+V to paste an image, video, or GIF', 'Utilise Ctrl+V pour coller une image, une vidéo ou un GIF'));
        return;
      }
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const mediaType =
          item.types.find((type) => type.startsWith('video/') || type === 'image/gif') ||
          item.types.find((type) => type.startsWith('image/'));
        if (!mediaType) continue;
        const blob = await item.getType(mediaType);
        const file = new File([blob], clipboardMediaName(mediaType), { type: mediaType });
        if (await importClipboardMediaFile(file)) return;
      }
      showImportNotice(t('The clipboard does not contain a supported image, video, or GIF', 'Le presse-papiers ne contient aucune image, vidéo ou GIF compatible'));
    } catch {
      showImportNotice(t('Allow clipboard access or use Ctrl+V', 'Autorise le presse-papiers ou utilise Ctrl+V'));
    }
  }

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const mediaFiles = Array.from(event.clipboardData?.items || [])
        .map((item) => item.kind === 'file' ? item.getAsFile() : null)
        .filter((file): file is File => Boolean(file))
        .filter((file) => isVideoMediaFile(file) || isStillImageFile(file));

      if (!mediaFiles.length) {
        if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
        pasteMediaFromClipboard().catch(() =>
          showImportNotice(t('Unable to paste this media', 'Impossible de coller ce média')),
        );
        return;
      }

      const pasteAsReference = Boolean(target?.closest('[data-reference-paste="true"]'));
      const referenceImages = mediaFiles.filter(isStillImageFile);
      event.preventDefault();
      if (pasteAsReference && selectedId && referenceImages.length) {
        addReferences(referenceImages, selectedId).catch(() =>
          showImportNotice(t('Unable to paste this reference', 'Impossible de coller cette référence')),
        );
        return;
      }

      importClipboardMediaFile(mediaFiles[0]).catch(() =>
        showImportNotice(t('Unable to paste this media', 'Impossible de coller ce média')),
      );
    }
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
    // The listener is refreshed for the active tab; helpers deliberately use that render closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, imageSource, selectedId]);

  function hasDraggedMedia(dataTransfer: DataTransfer) {
    return (
      Array.from(dataTransfer.items).some(
        (item) =>
          item.kind === 'file' &&
          (!item.type || item.type.startsWith('image/') || item.type.startsWith('video/')),
      ) ||
      Array.from(dataTransfer.files).some(
        (file) => isVideoMediaFile(file) || isStillImageFile(file),
      )
    );
  }

  function handleImageDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedMedia(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDraggingImage(true);
  }

  function handleImageDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setIsDraggingImage(false);
  }

  function handleImageDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingImage(false);
    const files = Array.from(event.dataTransfer.files);
    const videoFile = files.find(isVideoMediaFile);
    if (videoFile) {
      loadVideoFile(videoFile);
      return;
    }
    const imageFile = files.find(isStillImageFile);
    if (!imageFile) {
      showImportNotice(t('Drop a PNG, JPG, WebP image, video, or animated GIF', 'Dépose une image PNG, JPG, WebP, une vidéo ou un GIF animé'));
      return;
    }
    loadImageFile(imageFile).catch(() => showImportNotice(t('Unable to import this image', 'Impossible d’importer cette image')));
  }

  function addLayer() {
    const palette = ['#5ec8ff', '#a986ff', '#65d195', '#f47ec1', '#f2d05e'];
    const id = createId();
    const layer: Layer = {
      id,
      name: 'Calque ' + (layers.length + 1),
      color: palette[layers.length % palette.length],
      visible: true,
    };
    setLayers((items) => [...items, layer]);
    setActiveLayerId(id);
  }

  function renameLayer(layer: Layer) {
    const name = window.prompt('Nom du calque', layer.name)?.trim();
    if (name) setLayers((items) => items.map((item) => (item.id === layer.id ? { ...item, name } : item)));
  }

  function toggleLayer(layerId: string) {
    setLayers((items) =>
      items.map((layer) => (layer.id === layerId ? { ...layer, visible: !layer.visible } : layer)),
    );
  }

  async function addReferences(
    files: FileList | File[] | null,
    annotationId: string | null = selectedId,
  ) {
    if (!annotationId || !files?.length) return;
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (!imageFiles.length) {
      showImportNotice(t('Add only PNG, JPG, or WebP images', 'Ajoute uniquement des images PNG, JPG ou WebP'));
      return;
    }
    const newReferences = await Promise.all(
      imageFiles.map(async (file) => ({
        id: createId(),
        name: file.name || 'reference-collee.png',
        dataUrl: await readAsDataUrl(file),
      })),
    );
    const annotation = annotationsRef.current.find((item) => item.id === annotationId);
    if (!annotation) return;
    updateAnnotation(annotationId, {
      references: [...annotation.references, ...newReferences],
    });
    showImportNotice(
      newReferences.length + (newReferences.length > 1 ? t(' images added as references', ' images ajoutées en référence') : t(' image added as reference', ' image ajoutée en référence')),
    );
  }

  function hasDraggedImage(dataTransfer: DataTransfer) {
    return (
      Array.from(dataTransfer.items).some(
        (item) => item.kind === 'file' && (!item.type || item.type.startsWith('image/')),
      ) || Array.from(dataTransfer.files).some((file) => file.type.startsWith('image/'))
    );
  }

  function handleReferenceDragOver(event: DragEvent<HTMLElement>) {
    event.stopPropagation();
    if (!hasDraggedImage(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDraggingReference(true);
  }

  function handleReferenceDragLeave(event: DragEvent<HTMLElement>) {
    event.stopPropagation();
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setIsDraggingReference(false);
  }

  function handleReferenceDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingReference(false);
    const targetId = selectedId;
    if (!targetId) return;
    addReferences(Array.from(event.dataTransfer.files), targetId).catch(() =>
      showImportNotice(t('Unable to add this reference', 'Impossible d’ajouter cette référence')),
    );
  }

  function removeReference(referenceId: string) {
    if (!selected) return;
    updateAnnotation(selected.id, {
      references: selected.references.filter((reference) => reference.id !== referenceId),
    });
  }

  async function saveProjectFile() {
    if (integrationBridgeRef.current) {
      sendIntegrationDocument(projectData());
      return;
    }
    await downloadPackage({ delivery: false, includePrompt: false, container: 'project' });
  }

  async function openProjectFile(file?: File) {
    if (integrationBridgeRef.current) {
      showImportNotice(t('This window is linked to media from ', 'Cette fenêtre est liée à un média ') + integrationBridgeRef.current.providerLabel);
      return;
    }
    if (!file) return;
    try {
      let project: ProjectFile;
      if (file.name.toLowerCase().endsWith('.zip') || file.name.toLowerCase().endsWith('.cyannota') || file.type.includes('zip') || file.type.includes('cyannota')) {
        const archive = await JSZip.loadAsync(file);
        const workspaceEntry =
          archive.file('workspace.cyannota.json') ||
          Object.values(archive.files).find(
            (entry) => !entry.dir && entry.name.toLowerCase().endsWith('/workspace.cyannota.json'),
          );

        if (workspaceEntry) {
          type StoredTab =
            | { id: string; label: string; kind?: 'image'; project: ProjectFile }
            | { id: string; label: string; kind: 'video'; project: VideoProjectData; sourcePath?: string };
          const workspace = JSON.parse(await workspaceEntry.async('string')) as {
            workspaceVersion: number;
            locale?: unknown;
            workspaceInstructions?: unknown;
            activeTabId: string;
            tabs: StoredTab[];
          };
          if (![1, 2].includes(workspace.workspaceVersion) || !Array.isArray(workspace.tabs)) {
            throw new Error('Espace de travail invalide');
          }
          if (isAppLocale(workspace.locale)) changeLocale(workspace.locale);
          setWorkspaceInstructions(
            typeof workspace.workspaceInstructions === 'string' ? workspace.workspaceInstructions : '',
          );

          const restoredTabs: BoardTab[] = [];
          for (const storedTab of workspace.tabs) {
            if (storedTab.kind === 'video') {
              const videoProject = storedTab.project;
              if (
                videoProject?.version !== 1 ||
                videoProject.kind !== 'video' ||
                !Array.isArray(videoProject.annotations) ||
                !videoProject.sourcePath
              ) {
                throw new Error('Onglet vidéo invalide');
              }
              const sourceEntry =
                archive.file(storedTab.sourcePath || '') ||
                archive.file(videoProject.sourcePath) ||
                Object.values(archive.files).find(
                  (entry) => !entry.dir && entry.name.endsWith('/' + videoProject.sourcePath),
                );
              if (!sourceEntry) throw new Error('Vidéo source absente de l’onglet « ' + storedTab.label + ' »');
              const sourceBlob = await sourceEntry.async('blob');
              restoredTabs.push({
                id: storedTab.id,
                label: storedTab.label,
                kind: 'video',
                file: new File([sourceBlob], videoProject.videoName || 'video.mp4', {
                  type: videoProject.videoType || sourceBlob.type || 'video/mp4',
                  lastModified: Date.now(),
                }),
                project: structuredClone(videoProject),
              });
              continue;
            }

            const imageProject = storedTab.project;
            if (
              imageProject?.version !== 1 ||
              !Array.isArray(imageProject.layers) ||
              !Array.isArray(imageProject.annotations)
            ) {
              throw new Error('Onglet image invalide');
            }
            restoredTabs.push({
              id: storedTab.id,
              label: storedTab.label,
              kind: 'image',
              project: structuredClone(imageProject),
            });
          }

          if (!restoredTabs.length) throw new Error('Espace de travail vide');
          const nextActive =
            restoredTabs.find((tab) => tab.id === workspace.activeTabId) || restoredTabs[0];
          setTabs(restoredTabs);
          setActiveTabId(nextActive.id);
          if (nextActive.kind === 'image') applyProject(structuredClone(nextActive.project));
          showImportNotice(
            restoredTabs.length +
              ' onglet(s) image/vidéo restauré(s) depuis ' +
              (file.name.toLowerCase().endsWith('.cyannota') ? 'le projet CyAnnota' : 'le ZIP'),
          );
          return;
        }

        const videoProjectEntry =
          archive.file('video-project.cyannota.json') ||
          Object.values(archive.files).find(
            (entry) =>
              !entry.dir && entry.name.toLowerCase().endsWith('/video-project.cyannota.json'),
          );

        if (videoProjectEntry) {
          const videoProject = JSON.parse(await videoProjectEntry.async('string')) as VideoProjectData;
          if (
            videoProject.version !== 1 ||
            videoProject.kind !== 'video' ||
            !Array.isArray(videoProject.annotations) ||
            !videoProject.sourcePath
          ) {
            throw new Error('Projet vidéo CyAnnota invalide');
          }
          const sourceEntry =
            archive.file(videoProject.sourcePath) ||
            Object.values(archive.files).find(
              (entry) => !entry.dir && entry.name.endsWith('/' + videoProject.sourcePath),
            );
          if (!sourceEntry) throw new Error('Vidéo source absente du projet');
          const sourceBlob = await sourceEntry.async('blob');
          const restoredFile = new File([sourceBlob], videoProject.videoName || 'video.mp4', {
            type: videoProject.videoType || sourceBlob.type || 'video/mp4',
            lastModified: Date.now(),
          });
          loadVideoFile(restoredFile, videoProject);
          return;
        }

        const projectEntry =
          archive.file('project.annota.json') ||
          Object.values(archive.files).find(
            (entry) => !entry.dir && entry.name.toLowerCase().endsWith('/project.annota.json'),
          );
        if (!projectEntry) throw new Error('Projet CyAnnota absent du ZIP');
        project = JSON.parse(await projectEntry.async('string')) as ProjectFile;
      } else {
        project = JSON.parse(await file.text()) as ProjectFile;
      }

      if (
        project.version !== 1 ||
        !Array.isArray(project.layers) ||
        !Array.isArray(project.annotations)
      ) {
        throw new Error('Format invalide');
      }

      const label = project.image?.name || project.title || file.name;
      if (activeTab?.kind === 'video' || imageSource) createTab(project, label);
      else applyProject(project);
      showImportNotice(
        file.name.toLowerCase().endsWith('.cyannota')
          ? 'Projet .cyannota ouvert dans un onglet'
          : file.name.toLowerCase().endsWith('.zip')
          ? 'ZIP CyAnnota ouvert dans un onglet'
          : 'Projet CyAnnota ouvert',
      );
    } catch {
      window.alert(t('This file does not contain an editable CyAnnota project.', 'Ce fichier ne contient pas de projet CyAnnota modifiable.'));
    }
  }

  async function resumeDraft() {
    const project = await readDraft();
    if (!project) return;
    if (activeTab?.kind === 'video' || imageSource) createTab(project, project.image?.name || project.title);
    else applyProject(project);
  }

  function locationText(annotation: Annotation, promptLocale: AppLocale = locale) {
    const pt = (english: string, french: string) => translate(promptLocale, english, french);
    if (annotation.type === 'arrow') {
      return pt('from (', 'de (') + Math.round(annotation.x1) + ', ' + Math.round(annotation.y1) + pt(') to (', ') vers (') + Math.round(annotation.x2) + ', ' + Math.round(annotation.y2) + ')';
    }
    if (annotation.type === 'text') {
      return pt('at point (', 'au point (') + Math.round(annotation.x) + ', ' + Math.round(annotation.y) + ')';
    }
    if (annotation.type === 'draw') {
      const bounds = annotationBounds(annotation);
      return pt('area x=', 'zone x=') + Math.round(bounds.x) + ', y=' + Math.round(bounds.y) + pt(', width=', ', largeur=') + Math.round(bounds.w) + pt(', height=', ', hauteur=') + Math.round(bounds.h);
    }
    if (annotation.type === 'resize') {
      return 'source x=' + Math.round(annotation.sourceX) + ', y=' + Math.round(annotation.sourceY) +
        ', ' + Math.round(annotation.sourceW) + '×' + Math.round(annotation.sourceH) +
        pt(' px; target x=', ' px ; cible x=') + Math.round(annotation.x) + ', y=' + Math.round(annotation.y) +
        ', ' + Math.round(annotation.w) + '×' + Math.round(annotation.h) + ' px';
    }

    if (annotation.type === 'cut') {
      const dx = Math.round(annotation.x - annotation.sourceX);
      const dy = Math.round(annotation.y - annotation.sourceY);
      return 'source x=' + Math.round(annotation.sourceX) + ', y=' + Math.round(annotation.sourceY) + ', ' + Math.round(annotation.w) + '×' + Math.round(annotation.h) + pt(' px; destination x=', ' px ; destination x=') + Math.round(annotation.x) + ', y=' + Math.round(annotation.y) + pt('; move Δx=', ' ; déplacement Δx=') + dx + ', Δy=' + dy;
    }
    const bounds = annotationBounds(annotation);
    return 'x=' + Math.round(bounds.x) + ', y=' + Math.round(bounds.y) + pt(', width=', ', largeur=') + Math.round(bounds.w) + pt(', height=', ', hauteur=') + Math.round(bounds.h);
  }

  function buildPrompt(project: ProjectFile = projectData(), promptLocale: AppLocale = locale) {
    const pt = (english: string, french: string) => translate(promptLocale, english, french);
    const sourceAnnotations = createImageDeliveryProject(project).annotations;
    const sourceLayers = project.layers;
    const sourceImageName = project.image?.name || 'image.png';
    const mainImageMessage = project.globalInstructions.trim();
    const lines = [
      pt('# Interface correction brief — ', '# Brief de corrections — ') + project.title,
      '',
      pt('Modify the interface using “images/original-', 'Modifie l’interface à partir de « images/original-') + safeFileName(sourceImageName) + pt('”, following “images/annotated.png” and the numbered corrections below.', ' » en suivant « images/annotated.png » et les corrections numérotées ci-dessous.'),
      '',
      pt('## Main image message', '## Message principal de l’image'),
      '',
      mainImageMessage || pt('No main message was provided for this image.', 'Aucun message principal n’a été fourni pour cette image.'),
      '',
      pt(
        'This message applies to the whole image and to every correction below.',
        'Ce message s’applique à l’ensemble de l’image et à toutes les corrections ci-dessous.',
      ),
      '',
      pt('## Rules', '## Règles'),
      '',
      pt('- Follow the order and numbering of annotations.', '- Respecter l’ordre et la numérotation des annotations.'),
      pt('- Items linked to the same frame form one structured correction.', '- Les éléments liés au même cadre constituent une seule correction structurée.'),
      pt('- Red areas marked DELETE must be removed without any additional instruction.', '- Les zones rouges marquées SUPPRIMER doivent être retirées sans instruction supplémentaire.'),
      pt('- For a color annotation, replace the sampled color with the requested color.', '- Pour une annotation de couleur, remplacer la couleur prélevée par la couleur souhaitée.'),
      pt('- Preserve every item that is not explicitly affected.', '- Conserver tous les éléments qui ne sont pas explicitement concernés.'),
      pt('- Use reference images only for the correction to which they are attached.', '- Utiliser les images de référence uniquement pour la correction à laquelle elles sont jointes.'),
      '',
      '## Corrections',
      '',
    ];

    sourceAnnotations.forEach((annotation, index) => {
      const layer = sourceLayers.find((item) => item.id === annotation.layerId);
      const groupIndex = annotation.groupId
        ? sourceAnnotations.findIndex((item) => item.id === annotation.groupId)
        : -1;
      const frameChildren = annotation.type === 'frame'
        ? sourceAnnotations
            .map((item, childIndex) => ({ item, childIndex }))
            .filter(({ item }) => item.groupId === annotation.id)
            .map(({ childIndex }) => String(childIndex + 1).padStart(2, '0'))
        : [];
      const instruction = annotation.type === 'frame' && !hasFrameInstruction(annotation.description)
        ? frameChildren.length
          ? pt('Grouping frame: apply the instructions of its linked items.', 'Cadre de groupe : appliquer les consignes de ses éléments liés.')
          : mainImageMessage
            ? pt('Apply the main image message to this highlighted area.', 'Appliquer le message principal de l’image à cette zone encadrée.')
            : pt('MISSING INSTRUCTION — describe the expected change for this area.', 'CONSIGNE MANQUANTE — décrire le changement attendu pour cette zone.')
        : annotation.description.trim() || pt('Instruction to specify.', 'Instruction à préciser.');
      lines.push('### ' + String(index + 1).padStart(2, '0') + ' — ' + CATEGORY_LABELS[promptLocale][annotation.category]);
      lines.push('');
      lines.push(pt('- Type: ', '- Type : ') + TYPE_LABELS[promptLocale][annotation.type]);
      lines.push(pt('- Layer: ', '- Calque : ') + (layer?.name || pt('No layer', 'Sans calque')));
      if (groupIndex >= 0) {
        lines.push(pt('- Belongs to frame: ', '- Appartient au cadre : ') + String(groupIndex + 1).padStart(2, '0'));
      }
      lines.push(pt('- Position: ', '- Position : ') + locationText(annotation, promptLocale));
      lines.push(pt('- Instruction: ', '- Instruction : ') + instruction);

      if (annotation.type === 'frame') {
        lines.push(pt('- Frame items: ', '- Éléments du cadre : ') + (frameChildren.join(', ') || pt('none', 'aucun')));
      }
      if (annotation.type === 'shape') {
        lines.push(pt('- Shape: ', '- Forme : ') + annotation.shape + pt('; fill: ', ' ; remplissage : ') + annotation.fillColor);
      }
      if (annotation.type === 'delete') {
        lines.push(pt('- Automatic action: delete all content inside this area.', '- Action automatique : supprimer tout le contenu de cette zone.'));
      }
      if (annotation.type === 'color') {
        lines.push(
          pt('- Color: ', '- Couleur : ') +
            annotation.sampledColor.toUpperCase() +
            ' → ' +
            annotation.replacementColor.toUpperCase(),
        );
      }
      if (annotation.references.length) {
        lines.push(
          pt('- References: ', '- Références : ') +
            annotation.references
              .map((reference) => '« references/' + String(index + 1).padStart(2, '0') + '-' + safeFileName(reference.name) + ' »')
              .join(', '),
        );
      }
      if (annotation.type === 'cut' || annotation.type === 'resize') {
        lines.push(
          pt('- Cutout: “decoupes/', '- Découpe : « decoupes/') +
            String(index + 1).padStart(2, '0') +
            pt('-element.png”', '-element.png »') +
            (annotation.type === 'cut' && annotation.polygon?.length ? pt('; polygon outline.', ' ; contour polygonal.') : '.'),
        );
        if (annotation.type === 'resize') {
          lines.push(pt('- Resize: ', '- Redimensionnement : ') + Math.round(annotation.sourceW) + '×' + Math.round(annotation.sourceH) + ' px → ' + Math.round(annotation.w) + '×' + Math.round(annotation.h) + ' px.');
        }
      }
      lines.push('');
    });

    if (!sourceAnnotations.length) lines.push(pt('No correction was annotated.', 'Aucune correction annotée.'));
    lines.push(
      pt('## Completion criteria', '## Critère de fin'),
      '',
      pt('The final result must include every visible correction without changing the rest of the interface.', 'Le résultat final doit intégrer toutes les corrections visibles sans modifier le reste de l’interface.'),
    );
    return lines.join('\n');
  }

  function withWorkspaceInstructions(prompt: string, promptLocale: AppLocale = locale) {
    const message = workspaceInstructions.trim();
    if (!message) return prompt;
    const pt = (english: string, french: string) => translate(promptLocale, english, french);
    return [
      pt('# Workspace-wide message', '# Message global de l’espace de travail'),
      '',
      message,
      '',
      pt(
        'This instruction applies to every image and video tab in this package.',
        'Cette consigne s’applique à tous les onglets image et vidéo de ce paquet.',
      ),
      '',
      prompt,
    ].join('\n');
  }

  function videoOutputFormat(tab: VideoBoardTab): VideoOutputFormat {
    return preserveGifFormatInExport && isGifFile(tab.file) ? 'gif' : 'mp4';
  }

  function openExport() {
    const prompt = activeTab?.kind === 'video'
      ? buildVideoPrompt(createVideoDeliveryProject(
          activeTab.project,
          includeOriginalVideosInExport,
          videoOutputFormat(activeTab),
        ), locale)
      : buildPrompt(projectData(), locale);
    setExportPrompt(withWorkspaceInstructions(prompt, locale));
    setExportOpen(true);
  }

  function loadImageElement(source: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Image illisible'));
      image.src = source;
    });
  }

  async function loadProjectCutImages(project: ProjectFile) {
    const cache = new Map<string, HTMLImageElement>();
    await Promise.all(
      project.annotations
        .filter((annotation): annotation is CutAnnotation | ResizeAnnotation => annotation.type === 'cut' || annotation.type === 'resize')
        .map(async (annotation) => {
          try {
            cache.set(annotation.id, await loadImageElement(annotation.imageData));
          } catch {
            return;
          }
        }),
    );
    return cache;
  }

  async function renderProjectCanvas(
    project: ProjectFile,
    layerIds = new Set(project.layers.filter((layer) => layer.visible).map((layer) => layer.id)),
  ) {
    if (!project.image) throw new Error('Projet sans image');
    const original = await loadImageElement(project.image.src);
    const cutImages = await loadProjectCutImages(project);
    const output = document.createElement('canvas');
    output.width = original.naturalWidth;
    output.height = original.naturalHeight;
    const context = output.getContext('2d');
    if (!context) throw new Error('Canevas indisponible');
    context.drawImage(original, 0, 0, output.width, output.height);
    project.annotations.forEach((annotation, index) => {
      if (layerIds.has(annotation.layerId)) {
        drawAnnotation(
          context,
          annotation,
          index,
          false,
          output.width,
          cutImages,
          null,
          project.annotations,
        );
      }
    });
    return output;
  }

  function canvasBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Export impossible'))), 'image/png');
    });
  }

  async function downloadAnnotatedImage() {
    if (!imageSource) return;
    const canvas = await renderProjectCanvas(projectData());
    const saved = await downloadBlob(
      await canvasBlob(canvas),
      safeFileName(projectTitle) + '-annotated.png',
    );
    setSaveStatus(saved ? 'Image annotée enregistrée' : 'Enregistrement annulé');
  }

  async function addProjectToZip(
    zip: JSZip,
    project: ProjectFile,
    folderPath: string,
    prompt?: string,
  ) {
    zip.file(folderPath + 'project.annota.json', JSON.stringify(project, null, 2));
    if (prompt) zip.file(folderPath + 'prompt.md', prompt);

    if (!project.image) return;
    zip.file(
      folderPath + 'images/original-' + safeFileName(project.image.name),
      dataUrlBytes(project.image.src, `L’image source « ${project.image.name} »`),
    );

    const annotatedCanvas = await renderProjectCanvas(project);
    zip.file(folderPath + 'images/annotated.png', await canvasBlob(annotatedCanvas));

    for (const layer of project.layers) {
      const layerCanvas = await renderProjectCanvas(project, new Set([layer.id]));
      zip.file(
        folderPath + 'images/calque-' + safeFileName(layer.name) + '.png',
        await canvasBlob(layerCanvas),
      );
    }

    project.annotations.forEach((annotation, index) => {
      const number = String(index + 1).padStart(2, '0');
      if (annotation.type === 'cut' || annotation.type === 'resize') {
        zip.file(
          folderPath + 'decoupes/' + number + '-element.png',
          dataUrlBytes(annotation.imageData, `La découpe ${number}`),
        );
      }
      annotation.references.forEach((reference) => {
        zip.file(
          folderPath + 'references/' + number + '-' + safeFileName(reference.name),
          dataUrlBytes(reference.dataUrl, `La référence « ${reference.name} »`),
        );
      });
    });
  }

  async function encodeVideoTabForPackage(
    tab: VideoBoardTab,
    index: number,
    total: number,
    outputFormat: VideoOutputFormat,
  ) {
    const bounds = videoTrimBounds(tab.project);
    if (bounds.duration < 0.05) throw new Error('La découpe vidéo doit conserver au moins 0,05 seconde.');
    const signature = [
      tab.file.name,
      tab.file.size,
      tab.file.lastModified,
      bounds.start.toFixed(6),
      bounds.end.toFixed(6),
      outputFormat,
    ].join(':');
    const cached = encodedVideoCacheRef.current.get(tab.id);
    if (cached?.signature === signature) {
      setExportProgressLabel(t('Video ', 'Vidéo ') + (index + 1) + '/' + total + t(' · cut already encoded', ' · découpe déjà encodée'));
      return cached.blob;
    }
    const prefix = 'Vidéo ' + (index + 1) + '/' + total + ' · ';
    setExportProgressLabel(prefix + 'chargement du moteur local…');
    setSaveStatus(prefix + 'encodage de la découpe…');
    const blob = await encodeTrimmedVideo(
      tab.file,
      bounds.start,
      bounds.end,
      (progress) => {
        const label = prefix + 'encodage ' + outputFormat.toUpperCase() + ' · ' + progress + '%';
        setExportProgressLabel(label);
        setSaveStatus(label);
      },
      outputFormat,
    );
    encodedVideoCacheRef.current.set(tab.id, { signature, blob });
    return blob;
  }

  async function addVideoProjectToZip(
    zip: JSZip,
    tab: VideoBoardTab,
    project: VideoProjectData,
    trimmedVideo: Blob,
    includeOriginal: boolean,
    folderPath: string,
    prompt?: string,
  ) {
    zip.file(folderPath + 'video-project.cyannota.json', JSON.stringify(project, null, 2));
    if (prompt) zip.file(folderPath + 'prompt.md', prompt);
    const trimmedPath = project.trimmedPath || project.sourcePath;
    zip.file(folderPath + trimmedPath, trimmedVideo, { compression: 'STORE' });
    if (includeOriginal) {
      const originalPath = project.originalSourcePath || tab.project.sourcePath;
      if (originalPath !== trimmedPath) {
        zip.file(folderPath + originalPath, tab.file, { compression: 'STORE' });
      }
    }
    project.annotations.forEach((annotation, index) => {
      if (!annotation.snapshot) return;
      zip.file(
        folderPath + 'captures/' + String(index + 1).padStart(2, '0') + '-annotation.png',
        dataUrlBytes(annotation.snapshot, 'La capture vidéo ' + String(index + 1).padStart(2, '0')),
      );
    });
    const sortedStops = [...(project.frameStops || [])].sort((a, b) => a.time - b.time);
    for (let index = 0; index < sortedStops.length; index += 1) {
      const stop = sortedStops[index];
      zip.file(
        folderPath + 'frames/' + videoFrameStopFileName(stop, index),
        dataUrlBytes(stop.imageData, 'La frame vidéo ' + String(index + 1).padStart(2, '0')),
      );
      const annotatedFrame = await renderAnnotatedVideoFrameStop(stop);
      if (annotatedFrame) {
        zip.file(
          folderPath + 'frames/' + videoFrameStopAnnotatedFileName(stop, index),
          annotatedFrame,
        );
      }
    }
    if (sortedStops.length) {
      zip.file(
        folderPath + 'frames/manifest.json',
        JSON.stringify(
          sortedStops.map((stop, index) => ({
            frame: index + 1,
            sourceFrameIndex: stop.frameIndex ?? null,
            sourceFrameNumber: stop.frameIndex === undefined ? null : stop.frameIndex + 1,
            time: stop.time,
            timecode: formatVideoTime(stop.time),
            file: videoFrameStopFileName(stop, index),
            annotatedFile: stop.annotations?.length ? videoFrameStopAnnotatedFileName(stop, index) : null,
            annotations: stop.annotations || [],
          })),
          null,
          2,
        ),
      );
    }
  }

  async function createWorkspaceThumbnail(workspaceTabs: BoardTab[], currentActive?: BoardTab) {
    const width = 640;
    const height = 360;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Impossible de créer la miniature du projet.');
    context.fillStyle = '#111210';
    context.fillRect(0, 0, width, height);

    let source: CanvasImageSource | null = null;
    let sourceWidth = 0;
    let sourceHeight = 0;
    if (currentActive?.kind === 'image' && currentActive.project.image) {
      const rendered = await renderProjectCanvas(currentActive.project);
      source = rendered;
      sourceWidth = rendered.width;
      sourceHeight = rendered.height;
    } else if (currentActive?.kind === 'video') {
      const stop = currentActive.project.frameStops?.[0];
      if (stop?.imageData) {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error('La miniature vidéo est illisible.'));
          image.src = stop.imageData;
        });
        source = image;
        sourceWidth = image.naturalWidth;
        sourceHeight = image.naturalHeight;
      }
    }

    const footerHeight = 56;
    if (source && sourceWidth && sourceHeight) {
      const scale = Math.min(width / sourceWidth, (height - footerHeight) / sourceHeight);
      const drawWidth = sourceWidth * scale;
      const drawHeight = sourceHeight * scale;
      context.drawImage(source, (width - drawWidth) / 2, (height - footerHeight - drawHeight) / 2, drawWidth, drawHeight);
    } else {
      context.fillStyle = '#ff6554';
      context.font = '800 58px Segoe UI';
      context.textAlign = 'center';
      context.fillText(currentActive?.kind === 'video' ? 'VIDÉO' : 'CYANNOTA', width / 2, 165);
    }

    context.fillStyle = '#1b1b19ee';
    context.fillRect(0, height - footerHeight, width, footerHeight);
    context.textAlign = 'left';
    context.fillStyle = '#f1eee8';
    context.font = '700 18px Segoe UI';
    const title = (currentActive?.project.title || 'Projet CyAnnota').slice(0, 52);
    context.fillText(title, 18, height - 28);
    context.fillStyle = '#9b9891';
    context.font = '600 11px Segoe UI';
    context.fillText(workspaceTabs.length + ' onglet(s) · ' + (currentActive?.kind === 'video' ? 'vidéo' : 'image'), 18, height - 11);
    context.textAlign = 'right';
    context.fillStyle = '#ff8a78';
    context.font = '800 12px Segoe UI';
    context.fillText('CyAnnota', width - 18, height - 18);

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Impossible d’encoder la miniature du projet.')),
        'image/png',
      );
    });
  }

  async function downloadPackage(options: {
    delivery: boolean;
    includePrompt: boolean;
    container: ExportContainer;
    copyToClipboard?: boolean;
  }) {
    const workspaceTabs = saveActiveTab(tabs);
    const exportableTabs = workspaceTabs.filter(
      (tab) => tab.kind === 'video' || Boolean(tab.project.image),
    );
    if (!exportableTabs.length) return false;
    if (false && options.includePrompt) {
      const unresolvedFrames = exportableTabs.flatMap((tab, tabIndex) =>
        tab.kind === 'image'
          ? tab.project.annotations
              .filter(() => false)
              .map(() => String(tabIndex + 1).padStart(2, '0') + ' — ' + tab.label)
          : [],
      );
      if (unresolvedFrames.length) {
        window.alert(
          t('AI export blocked: ', 'Export IA bloqué : ') + unresolvedFrames.length +
          t(' frame(s) have no usable instruction. Add a message to each frame or a main image message before exporting.\n\nAffected tabs:\n', ' cadre(s) n’ont aucune consigne exploitable. Ajoutez un message à chaque cadre ou un message principal à l’image avant l’export.\n\nOnglets concernés :\n') +
          Array.from(new Set(unresolvedFrames)).join('\n'),
        );
        setSaveStatus(t('Missing annotation messages', 'Messages d’annotation manquants'));
        return false;
      }
    }
    const currentActive = workspaceTabs.find((tab) => tab.id === activeTabId);
    const packageTitle =
      currentActive?.kind === 'video' ? currentActive.project.title : projectTitle;
    const packageName =
      safeFileName(packageTitle || 'cyannota') +
      (options.container === 'project' ? '.cyannota' : '.cyannota.zip');
    const exportFolder = (tab: BoardTab, index: number) =>
      t('tabs/', 'onglets/') +
      String(index + 1).padStart(2, '0') +
      '-' +
      safeFileName(tab.label) +
      '/';
    const isDeliveryExport = options.delivery;
    const includeOriginalVideos = !isDeliveryExport || includeOriginalVideosInExport;
    const packagedImageProjects = new Map<string, ProjectFile>();
    const packagedVideoProjects = new Map<string, VideoProjectData>();
    workspaceTabs.forEach((tab) => {
      if (tab.kind === 'image') {
        packagedImageProjects.set(
          tab.id,
          isDeliveryExport ? createImageDeliveryProject(tab.project) : tab.project,
        );
        return;
      }
      packagedVideoProjects.set(
        tab.id,
        isDeliveryExport
          ? createVideoDeliveryProject(tab.project, includeOriginalVideos, videoOutputFormat(tab))
          : createVideoSaveProject(tab.project),
      );
    });

    setIsExporting(true);
    setExportProgressLabel(t('Preparing package…', 'Préparation du paquet…'));
    try {
      const preparedSave = await prepareFileSave(packageName);
      if (!preparedSave) {
        setSaveStatus(t('Save cancelled', 'Enregistrement annulé'));
        return false;
      }

      const zip = new JSZip();
      const storedTabs = workspaceTabs.map((tab) => {
        if (tab.kind === 'image') {
          return {
            id: tab.id,
            label: tab.label,
            kind: 'image' as const,
            project: packagedImageProjects.get(tab.id) || tab.project,
          };
        }
        const exportIndex = exportableTabs.findIndex((item) => item.id === tab.id);
        const folder = exportFolder(tab, Math.max(0, exportIndex));
        const packagedProject = packagedVideoProjects.get(tab.id) || tab.project;
        return {
          id: tab.id,
          label: tab.label,
          kind: 'video' as const,
          project: packagedProject,
          sourcePath: folder + packagedProject.sourcePath,
        };
      });
      zip.file(
        'workspace.cyannota.json',
        JSON.stringify(
          {
            workspaceVersion: 2,
            locale,
            workspaceInstructions,
            activeTabId,
            tabs: storedTabs,
          },
          null,
          2,
        ),
      );
      const imageCount = exportableTabs.filter((tab) => tab.kind === 'image').length;
      const videoCount = exportableTabs.length - imageCount;
      const correctionCount = exportableTabs.reduce((count, tab) => {
        if (tab.kind === 'image') {
          return count + (packagedImageProjects.get(tab.id) || tab.project).annotations.length;
        }
        const packagedProject = packagedVideoProjects.get(tab.id) || tab.project;
        return count + packagedProject.annotations.length + (packagedProject.frameStops || []).reduce(
          (stopCount, stop) => stopCount + (stop.annotations || []).length,
          0,
        );
      }, 0);
      const packagedWorkspaceTabs: BoardTab[] = workspaceTabs.map((tab) =>
        tab.kind === 'image'
          ? { ...tab, project: packagedImageProjects.get(tab.id) || tab.project }
          : { ...tab, project: packagedVideoProjects.get(tab.id) || tab.project },
      );
      const packagedCurrentActive = packagedWorkspaceTabs.find((tab) => tab.id === activeTabId);
      const thumbnail = await createWorkspaceThumbnail(packagedWorkspaceTabs, packagedCurrentActive);
      zip.file('thumbnail.png', thumbnail);
      zip.file(
        'manifest.cyannota.json',
        JSON.stringify(
          {
            format: 'cyannota-project',
            formatVersion: 1,
            title: packageTitle || 'CyAnnota',
            updatedAt: new Date().toISOString(),
            container: options.container,
            audience: options.includePrompt ? 'ai' : 'human',
            locale,
            workspace: 'workspace.cyannota.json',
            thumbnail: 'thumbnail.png',
            activeTabId,
            tabCount: exportableTabs.length,
            imageCount,
            videoCount,
            correctionCount,
            sourceApplication: 'CyAnnota',
          },
          null,
          2,
        ),
      );
      zip.file(
        t('README.txt', 'LISEZ-MOI.txt'),
        (options.container === 'project' ? t('CyAnnota project', 'Projet CyAnnota') : t('CyAnnota archive', 'Archive CyAnnota')) +
          t(' containing ', ' contenant ') +
          exportableTabs.length +
          t(' image/video tab(s). ', ' onglet(s) image/vidéo. ') +
          (options.includePrompt
            ? t('AI mode: correction prompts are included. ', 'Mode IA : les prompts de correction sont inclus. ')
            : t('Human mode: no prompt is included. ', 'Mode Humain : aucun prompt n’est inclus. ')) +
          (isDeliveryExport
            ? t('Videos are trimmed and re-encoded. Original sources are ', 'Les vidéos sont découpées et réencodées. Les sources originales sont ') + (includeOriginalVideos ? t('also included.', 'également incluses.') : t('omitted to keep the package lightweight.', 'omises pour alléger le paquet.'))
            : t('The save contains source videos and their trimmed, re-encoded versions.', 'La sauvegarde contient les vidéos sources ainsi que leurs versions découpées et réencodées.')) +
          t(' Open this file directly in CyAnnota to restore the workspace.', ' Ouvrez directement ce fichier dans CyAnnota pour restaurer l’espace de travail.'),
      );

      let videoIndex = 0;
      const totalVideos = exportableTabs.filter((tab) => tab.kind === 'video').length;
      for (let index = 0; index < exportableTabs.length; index += 1) {
        const tab = exportableTabs[index];
        const folder = exportFolder(tab, index);
        try {
          if (tab.kind === 'video') {
            const packagedProject = packagedVideoProjects.get(tab.id);
            if (!packagedProject) throw new Error('Projet vidéo préparé introuvable.');
            const generatedPrompt = options.includePrompt
              ? withWorkspaceInstructions(buildVideoPrompt(packagedProject, locale), locale)
              : undefined;
            const prompt =
              options.includePrompt && options.delivery && tab.id === activeTabId && exportPrompt
                ? exportPrompt
                : generatedPrompt;
            const trimmedVideo = await encodeVideoTabForPackage(
              tab,
              videoIndex,
              totalVideos,
              packagedProject.videoType === 'image/gif' ? 'gif' : 'mp4',
            );
            videoIndex += 1;
            await addVideoProjectToZip(
              zip,
              tab,
              packagedProject,
              trimmedVideo,
              includeOriginalVideos,
              folder,
              prompt,
            );
          } else {
            const packagedProject = packagedImageProjects.get(tab.id) || tab.project;
            const generatedPrompt = options.includePrompt
              ? withWorkspaceInstructions(buildPrompt(packagedProject, locale), locale)
              : undefined;
            const prompt =
              options.includePrompt && options.delivery && tab.id === activeTabId && exportPrompt
                ? exportPrompt
                : generatedPrompt;
            await addProjectToZip(zip, packagedProject, folder, prompt);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(t('Tab “', 'Onglet « ') + tab.label + t('”: ', ' » : ') + detail);
        }
      }
      const containerLabel = options.container === 'project' ? t('CyAnnota project', 'projet CyAnnota') : 'ZIP';
      setExportProgressLabel(t('Compressing ', 'Compression du ') + containerLabel + '…');
      const archive = await zip.generateAsync(
        {
          type: 'blob',
          mimeType: options.container === 'project' ? 'application/x-cyannota' : 'application/zip',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 },
        },
        (metadata) => setExportProgressLabel(t('Compressing ', 'Compression du ') + containerLabel + ' · ' + Math.round(metadata.percent) + '%'),
      );
      const saveResult = await savePreparedBlob(archive, preparedSave, {
        copyToClipboard: options.copyToClipboard === true,
      });
      const saved = saveResult.saved;
      const renamedLabel = saveResult.renamed
        ? t(' · renamed to ', ' · renommé en ') + saveResult.fileName
        : '';
      const clipboardLabel = options.copyToClipboard
        ? saveResult.copied
          ? t(' · copied to clipboard', ' · copié dans le presse-papiers')
          : t(' · clipboard unavailable', ' · presse-papiers indisponible')
        : '';
      setSaveStatus(
        (saved
          ? options.delivery
            ? t('Export ', 'Export ') + (options.includePrompt ? t('AI', 'IA') : t('Human', 'Humain')) + t(' saved', ' enregistré')
            : t('CyAnnota project saved with sources', 'Projet CyAnnota enregistré avec les sources')
          : t('Save cancelled', 'Enregistrement annulé')) +
        (saved ? renamedLabel + clipboardLabel : ''),
      );
      setExportProgressLabel(
        saved
          ? saveResult.copied
            ? t('Package saved and copied', 'Paquet enregistré et copié')
            : t('Package saved', 'Paquet enregistré')
          : t('Save cancelled', 'Enregistrement annulé'),
      );
      if (saved && options.copyToClipboard && !saveResult.copied) {
        showImportNotice(
          t('File saved, but the browser refused clipboard file access.', 'Fichier enregistré, mais le navigateur a refusé la copie du fichier.') +
          (saveResult.copyError ? ' ' + saveResult.copyError : ''),
        );
      }
      return saved;
    } catch (error) {
      const message = error instanceof Error ? error.message : t('unknown error', 'erreur inconnue');
      setSaveStatus(t('CyAnnota save failed', 'Échec de l’enregistrement CyAnnota'));
      setExportProgressLabel(t('Encoding or export failed', 'Encodage ou export impossible'));
      showImportNotice(t('Save failed: ', 'Enregistrement impossible : ') + message);
      await showSaveFailure(t('Unable to save the CyAnnota file.', 'Impossible d’enregistrer le fichier CyAnnota.'), error);
      throw error;
    } finally {
      setIsExporting(false);
    }
  }
  async function copyPrompt() {
    await navigator.clipboard.writeText(exportPrompt);
  }


  function renderWorkspaceMessageDialog() {
    if (!workspaceMessageOpen) return null;
    return (
      <div className="modal-backdrop" onMouseDown={() => setWorkspaceMessageOpen(false)}>
        <section className="export-modal workspace-message-modal" onMouseDown={(event) => event.stopPropagation()}>
          <header className="modal-header">
            <div>
              <p className="eyebrow">{t('ALL TABS', 'TOUS LES ONGLETS')}</p>
              <h2>{t('Workspace-wide message', 'Message global de l’espace de travail')}</h2>
              <p>{t(
                'Use this for an instruction or context that applies to every open image and video tab.',
                'Utilise ce message pour une consigne ou un contexte qui concerne tous les onglets image et vidéo ouverts.',
              )}</p>
            </div>
            <button className="modal-close" aria-label={t('Close', 'Fermer')} onClick={() => setWorkspaceMessageOpen(false)}>×</button>
          </header>
          <label className="workspace-message-editor">
            <span>{t('Message included before every tab prompt', 'Message ajouté avant le prompt de chaque onglet')}</span>
            <textarea
              autoFocus
              value={workspaceInstructions}
              onChange={(event) => setWorkspaceInstructions(event.target.value)}
              placeholder={t(
                'Example: Keep a consistent visual language across every screen and video…',
                'Ex. Conserver un langage visuel cohérent sur tous les écrans et toutes les vidéos…',
              )}
            />
          </label>
          <p className="workspace-message-note">{t(
            'The message is saved inside the .cyannota project. Human exports keep it as project data but do not create prompt files.',
            'Le message est sauvegardé dans le projet .cyannota. Les exports Humain le conservent comme donnée du projet mais ne créent aucun fichier de prompt.',
          )}</p>
          <footer className="modal-actions">
            <button className="button ghost" onClick={() => setWorkspaceInstructions('')} disabled={!workspaceInstructions}>{t('Clear', 'Effacer')}</button>
            <button className="button primary" onClick={() => setWorkspaceMessageOpen(false)}>{t('Done', 'Terminer')}</button>
          </footer>
        </section>
      </div>
    );
  }
  function renderExportDialog() {
    if (!exportOpen) return null;
    const correctionCount = tabs.reduce(
      (count, tab) => count + tab.project.annotations.length + (
        tab.kind === 'video'
          ? (tab.project.frameStops || []).reduce((stopCount, stop) => stopCount + (stop.annotations || []).length, 0)
          : 0
      ),
      0,
    );
    const videoCount = tabs.filter((tab) => tab.kind === 'video').length;
    const gifCount = tabs.filter(
      (tab) => tab.kind === 'video' && isGifFile(tab.file),
    ).length;
    const frameStopCount = tabs.reduce(
      (count, tab) =>
        count +
        (tab.kind === 'video'
          ? (tab.project.frameStops || []).length
          : 0),
      0,
    );

    return (
      <div className="modal-backdrop" onMouseDown={() => setExportOpen(false)}>
        <section className="export-modal" onMouseDown={(event) => event.stopPropagation()}>
          <header className="modal-header">
            <div>
              <p className="eyebrow">{t('COMPLETE CORRECTION PACKAGE', 'PAQUET DE CORRECTIONS COMPLET')}</p>
              <h2>{exportAudience === 'human' ? t('Package ready for a person', 'Dossier prêt pour une personne') : t('Images and videos ready for AI', 'Images et vidéos prêtes pour une IA')}</h2>
              <p>{exportAudience === 'human' ? t('The package contains media, annotations, and thumbnails, with no prompt.', 'Le paquet contient les médias, les annotations et la miniature, sans aucun prompt.') : t('The package also contains structured prompts for sending corrections to an AI.', 'Le paquet contient aussi les prompts structurés pour transmettre les corrections à une IA.')}</p>
            </div>
            <button className="modal-close" aria-label={t('Close', 'Fermer')} onClick={() => setExportOpen(false)}>×</button>
          </header>

          <div className="export-stats">
            <div><strong>{tabs.length}</strong><span>{t('tabs', 'onglets')}</span></div>
            <div><strong>{correctionCount}</strong><span>{t('corrections', 'corrections')}</span></div>
            <div><strong>{videoCount}</strong><span>{t('videos', 'vidéos')}</span></div>
            <div><strong>{frameStopCount}</strong><span>{t('frame stops', 'arrêts image')}</span></div>
          </div>

          <div className="export-mode-grid" aria-label={t('Export options', 'Options d’export')}>
            <fieldset className="export-choice-group">
              <legend>{t('Recipient', 'Destinataire')}</legend>
              <button
                type="button"
                className={exportAudience === 'human' ? 'export-choice active' : 'export-choice'}
                onClick={() => setExportAudience('human')}
                disabled={isExporting}
              >
                <strong>{t('Human', 'Humain')}</strong><small>{t('Media and annotations, without a prompt', 'Médias et annotations, sans prompt')}</small>
              </button>
              <button
                type="button"
                className={exportAudience === 'ai' ? 'export-choice active' : 'export-choice'}
                onClick={() => setExportAudience('ai')}
                disabled={isExporting}
              >
                <strong>{t('AI', 'IA')}</strong><small>{t('Adds structured prompts', 'Ajoute les prompts structurés')}</small>
              </button>
            </fieldset>
            <fieldset className="export-choice-group">
              <legend>{t('Format', 'Format')}</legend>
              <button
                type="button"
                className={exportContainer === 'project' ? 'export-choice active' : 'export-choice'}
                onClick={() => setExportContainer('project')}
                disabled={isExporting}
              >
                <strong>{t('.cyannota project', 'Projet .cyannota')}</strong><small>{t('Recognized by CyTask and the desktop app', 'Reconnu par CyTask et le bureau')}</small>
              </button>
              <button
                type="button"
                className={exportContainer === 'zip' ? 'export-choice active' : 'export-choice'}
                onClick={() => setExportContainer('zip')}
                disabled={isExporting}
              >
                <strong>{t('ZIP archive', 'Archive ZIP')}</strong><small>{t('Compatible with the current workflow', 'Compatible avec le flux actuel')}</small>
              </button>
            </fieldset>
          </div>

          {exportAudience === 'ai' && (
            <label className="prompt-editor">
              <span>{t('Active tab prompt — you can still edit it', 'Prompt de l’onglet actif — tu peux encore le modifier')}</span>
              <textarea value={exportPrompt} onChange={(event) => setExportPrompt(event.target.value)} />
            </label>
          )}

          {videoCount > 0 && (
            <label className="export-original-option">
              <input
                type="checkbox"
                checked={includeOriginalVideosInExport}
                disabled={isExporting}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setIncludeOriginalVideosInExport(checked);
                  if (activeTab?.kind === 'video') {
                    const replacement = checked
                      ? t('- The original source video is also included as reference data.', '- La vidéo source originale est également jointe comme donnée de référence.')
                      : t('- The original source video is not included in this lightweight package.', '- La vidéo source originale n’est pas incluse dans ce paquet léger.');
                    setExportPrompt((current) => current.replace(
                      /^- (?:The original source video|La vidéo source originale).*$/m,
                      replacement,
                    ));
                  }
                }}
              />
              <span><strong>{t('Also include original videos', 'Inclure aussi les vidéos originales')}</strong><small>{t('Larger, but useful when the recipient needs the complete source capture.', 'Plus lourd, mais utile si le destinataire doit retrouver toute la capture source.')}</small></span>
            </label>
          )}
          {gifCount > 0 && (
            <label className="export-original-option">
              <input
                type="checkbox"
                checked={preserveGifFormatInExport}
                disabled={isExporting}
                onChange={(event) => setPreserveGifFormatInExport(event.target.checked)}
              />
              <span>
                <strong>{t('Export animated GIFs as GIF', 'Exporter les GIF animés au format GIF')}</strong>
                <small>{t('Keeps a true animated GIF in the package. MP4 remains recommended for a lighter file and smoother playback.', 'Conserve un vrai GIF animé dans le paquet. Le MP4 reste recommandé pour un fichier plus léger et une lecture plus fluide.')}</small>
              </span>
            </label>
          )}
          <label className="export-original-option">
            <input
              type="checkbox"
              checked={copyExportToClipboard}
              disabled={isExporting}
              onChange={(event) => setCopyExportToClipboard(event.target.checked)}
            />
            <span>
              <strong>{t('Copy exported file to clipboard', 'Copier le fichier exporté dans le presse-papiers')}</strong>
              <small>{t('Desktop: paste the saved file directly into Discord or Explorer. Web support depends on the browser.', 'Bureau : colle directement le fichier enregistré dans Discord ou l’Explorateur. Sur le Web, cela dépend du navigateur.')}</small>
            </span>
          </label>
            {isExporting && <div className="export-encoding-status"><span className="status-dot" /><strong>{exportProgressLabel || t('Local encoding in progress…', 'Encodage local en cours…')}</strong></div>}

          <footer className="modal-actions">
            {exportAudience === 'ai' && (
              <button className="button ghost" onClick={() => copyPrompt().catch(() => undefined)}>{t('Copy prompt', 'Copier le prompt')}</button>
            )}
            {activeTab?.kind === 'image' && activeTab.project.image && (
              <button className="button ghost" onClick={() => downloadAnnotatedImage().catch(() => undefined)}>{t('Annotated image', 'Image annotée')}</button>
            )}
            <button
              className="button primary large"
              onClick={() => downloadPackage({
                delivery: true,
                includePrompt: exportAudience === 'ai',
                copyToClipboard: copyExportToClipboard,
                container: exportContainer,
              }).catch(() => undefined)}
              disabled={isExporting}
            >
              {isExporting
                ? t('Encoding and creating…', 'Encodage et création en cours…')
                : t('Export', 'Exporter') + ' · ' + (exportAudience === 'human' ? t('Human', 'Humain') : t('AI', 'IA')) + ' · ' + (exportContainer === 'project' ? '.cyannota' : 'ZIP')}
            </button>
          </footer>
        </section>
      </div>
    );
  }

  const toolIcons: Record<Tool, string> = {
    select: '↖',
    pan: '✥',
    frame: '▣',
    shape: '○',
    rect: '□',
    arrow: '↗',
    text: 'T',
    draw: '✎',
    cut: '✂',
    resize: '⤢',
    polycut: '△',
    delete: '⌫',
    eyedropper: '◉',
  };

  function renderMediaTabs() {
    return (
      <div className="board-tabs" role="tablist" aria-label={t('Open media', 'Médias ouverts')}>
        <div className="board-tabs-scroll">
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              className={
                'board-tab ' +
                (tab.kind === 'video' ? 'media-video ' : 'media-image ') +
                (tab.id === activeTabId ? 'active' : '')
              }
              role="presentation"
            >
              <button
                className="board-tab-main"
                role="tab"
                aria-selected={tab.id === activeTabId}
                onClick={() => activateTab(tab.id)}
                title={tab.label}
              >
                <span className="board-tab-index">
                  {tab.kind === 'video' ? 'VID' : String(index + 1).padStart(2, '0')}
                </span>
                <span className="board-tab-label">{tab.label}</span>
              </button>
              <button
                className="board-tab-close"
                aria-label={t('Close ', 'Fermer ') + tab.label}
                onClick={() => closeTab(tab.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {!integrationBridge && (
          <button
            className="new-board-tab"
            aria-label={t('New image tab', 'Nouvel onglet d’image')}
            title={t('New image tab', 'Nouvel onglet d’image')}
            onClick={() => createTab()}
          >
            +
          </button>
        )}
      </div>
    );
  }

  if (activeTab?.kind === 'video') {
    return (
      <>
        <VideoAnnotator
          key={activeTab.id}
          file={activeTab.file}
          initialProject={activeTab.project}
          onSaveBlob={downloadBlob}
          onProjectChange={(project) => updateVideoTab(activeTab.id, project)}
          workspaceStatus={saveStatus}
          workspaceBusy={isExporting}
          onCaptureFrame={(captureFile, time) =>
            openVideoFrameAsImage(captureFile, time, activeTab.project.title)
          }
          tabBar={renderMediaTabs()}
          onOpenWorkspace={integrationBridge ? undefined : () => projectInputRef.current?.click()}
          onAddImage={integrationBridge ? undefined : () => imageInputRef.current?.click()}
          onAddVideo={integrationBridge ? undefined : () => videoInputRef.current?.click()}
          onSaveWorkspace={() => {
            if (integrationBridge) sendIntegrationDocument(activeTab.project);
            else saveProjectFile().catch(() => undefined);
          }}
          onExportWorkspace={openExport}
          onEditWorkspaceMessage={() => setWorkspaceMessageOpen(true)}
          workspaceInstructions={workspaceInstructions}
          locale={locale}
          onLocaleChange={changeLocale}
        />
        <input
          ref={projectInputRef}
          hidden
          type="file"
          accept=".cyannota,.json,.annota.json,.zip,application/x-cyannota,application/json,application/zip"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            openProjectFile(event.target.files?.[0]).catch(() => undefined);
            event.target.value = '';
          }}
        />
        <input
          ref={videoInputRef}
          hidden
          type="file"
          accept="video/mp4,video/webm,video/ogg,video/quicktime,image/gif,.mp4,.webm,.ogg,.mov,.m4v,.gif"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            loadVideoFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <input
          ref={imageInputRef}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            loadImageFile(event.target.files?.[0]).catch(() => undefined);
            event.target.value = '';
          }}
        />
        {renderExportDialog()}
        {renderWorkspaceMessageDialog()}
      </>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-mark" src="/cyannota-logo.png" alt="" />
          <div>
            <strong>CyAnnota</strong>
            <span className="brand-subtitle">{t('Image and video annotations', 'Annotations image et vidéo')}</span>
            <VersionStatus locale={locale} />
          </div>
        </div>

        <div className="tool-context top-tool-context">
          <span className="mini-tool">{toolIcons[tool]}</span>
          <div>
            <strong>{TOOL_LABELS[locale][tool]}</strong>
            <span>{TOOL_HELP[locale][tool]}</span>
          </div>
        </div>

        <label className="project-title">
          <span className="status-dot" />
          <input
            aria-label={t('Project name', 'Nom du projet')}
            value={projectTitle}
            onChange={(event) => setProjectTitle(event.target.value)}
          />
        </label>


        <button
          className={'button ghost compact workspace-message-button top-global-message' + (workspaceInstructions.trim() ? ' active' : '')}
          onClick={() => setWorkspaceMessageOpen(true)}
        >
          {t('Global message', 'Message global')}
        </button>
        <div className="top-actions">
          <label className="language-picker" title={t('Interface and prompt language', 'Langue de l’interface et des prompts')}>
            <span>{locale.toUpperCase()}</span>
            <select value={locale} onChange={(event) => changeLocale(event.target.value as AppLocale)} aria-label={t('Language', 'Langue')}>
              <option value="en">English</option>
              <option value="fr">Français</option>
            </select>
          </label>
          {hasLocalDraft && !imageSource && (
            <button className="button ghost compact" onClick={() => resumeDraft().catch(() => undefined)}>
              {t('Resume', 'Reprendre')}
            </button>
          )}
          {integrationBridge && (
            <span className="cytask-bridge-badge">
              {integrationBridge.providerLabel + (integrationBridge.readOnly ? ' · consultation' : ' · lié')}
            </span>
          )}
          {!integrationBridge && (
            <>
              <button className="button ghost compact" onClick={() => projectInputRef.current?.click()}>
                {t('Open', 'Ouvrir')}
              </button>
              <button className="button ghost compact" onClick={() => videoInputRef.current?.click()}>
                {t('Video', 'Vidéo')}
              </button>
            </>
          )}
          <button
            className="button ghost compact"
            onClick={() => saveProjectFile().catch(() => undefined)}
            disabled={!hasExportableMedia || isExporting}
          >
            {integrationBridge ? t('Save to ', 'Sauver dans ') + integrationBridge.providerLabel : t('Save', 'Sauver')}
          </button>
          <button className="button primary" onClick={openExport} disabled={!hasExportableMedia}>
            {t('Export', 'Exporter')}
          </button>
        </div>

        <input
          ref={projectInputRef}
          hidden
          type="file"
          accept=".cyannota,.json,.annota.json,.zip,application/x-cyannota,application/json,application/zip"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            openProjectFile(event.target.files?.[0]).catch(() => undefined);
            event.target.value = '';
          }}
        />
        <input
          ref={videoInputRef}
          hidden
          type="file"
          accept="video/mp4,video/webm,video/ogg,video/quicktime,image/gif,.mp4,.webm,.ogg,.mov,.m4v,.gif"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            loadVideoFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </header>

      <section className="workspace">
        <aside className="toolrail" aria-label={t('Annotation tools', 'Outils d’annotation')}>
          {(Object.keys(toolIcons) as Tool[]).map((item) => (
            <button
              key={item}
              className={'tool ' + (tool === item ? 'active' : '')}
              data-label={TOOL_LABELS[locale][item]}
              aria-label={TOOL_LABELS[locale][item]}
              onClick={() => {
                setTool(item);
                if (item !== 'polycut') setPolygonPoints([]);
              }}
              disabled={!imageSource}
            >
              {toolIcons[item]}
            </button>
          ))}
          <span className="tool-divider" />
          <button
            className="tool"
            data-label={t('Undo', 'Annuler')}
            aria-label={t('Undo', 'Annuler')}
            onClick={undo}
            disabled={!past.length}
          >
            ↶
          </button>
          <button
            className="tool"
            data-label={t('Redo', 'Rétablir')}
            aria-label={t('Redo', 'Rétablir')}
            onClick={redo}
            disabled={!future.length}
          >
            ↷
          </button>
          <span className="tool-spacer" />
          <button
            className="tool danger"
            data-label={t('Delete selection', 'Supprimer la sélection')}
            aria-label={t('Delete selection', 'Supprimer la sélection')}
            onClick={deleteSelected}
            disabled={!selected}
          >
            ×
          </button>
        </aside>

        <section className="stage-wrap">
          {renderMediaTabs()}


          <div
            ref={stageRef}
            className={
              'stage ' +
              (imageSource ? 'has-image ' : '') +
              (isDraggingImage ? 'is-dragging' : '')
            }
            onDragEnter={handleImageDragOver}
            onDragOver={handleImageDragOver}
            onDragLeave={handleImageDragLeave}
            onDrop={handleImageDrop}
          >
            {imageSource ? (
              <div className="canvas-scroll-space">
                <div
                  className="canvas-wrap"
                  style={{
                    width: imageSize.width,
                    height: imageSize.height,
                    transform: 'translate3d(' + pan.x + 'px, ' + pan.y + 'px, 0) scale(' + zoom + ')',
                  }}
                >
                  <canvas
                    ref={canvasRef}
                    width={imageSize.width}
                    height={imageSize.height}
                    className={
                      'annotation-canvas cursor-' +
                      (isPanning ? 'panning' : isSpaceHeld ? 'pan' : tool)
                    }
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerMoveEnd}
                    onPointerCancel={handlePointerMoveEnd}
                    onContextMenu={(event) => event.preventDefault()}
                  />
                </div>
              </div>
            ) : (
              <div className="drop-card">
                <div className="drop-icon">⌁</div>
                <p className="eyebrow">{t('NEW BOARD', 'NOUVELLE PLANCHE')}</p>
                <h1>{t('Drop an image or video', 'Dépose une image ou une vidéo')}</h1>
                <p>{t('PNG, JPG, WebP, video, or animated GIF — every file remains on this computer.', 'PNG, JPG, WebP, vidéo ou GIF animé — tous les fichiers restent sur cet ordinateur.')}</p>
                <div className="import-actions">
                  <button className="button primary large" onClick={() => imageInputRef.current?.click()}>
                    {t('Choose an image', 'Choisir une image')}
                  </button>
                  <button className="button ghost large" onClick={() => videoInputRef.current?.click()}>
                    {t('Choose a video', 'Choisir une vidéo')}
                  </button>
                  <button className="button ghost large" onClick={() => pasteMediaFromClipboard().catch(() => undefined)}>
                    {t('Paste media', 'Coller un média')}
                  </button>
                </div>
                <span>{t('or drag and drop a file · Ctrl+V works for images, videos, and GIFs', 'ou glisse-dépose un fichier · Ctrl+V fonctionne pour les images, vidéos et GIF')}</span>
                {hasLocalDraft && (
                  <button className="text-button" onClick={() => resumeDraft().catch(() => undefined)}>
                    {t('Resume last project', 'Reprendre le dernier projet')}
                  </button>
                )}
              </div>
            )}
            {isDraggingImage && (
              <div className="stage-drop-overlay" aria-live="polite">
                <span>↓</span>
                <strong>{t('Drop the file here', 'Dépose le fichier ici')}</strong>
                <small>{t('Image or video, it will remain processed locally', 'Image ou vidéo, il restera traité localement')}</small>
              </div>
            )}
            {importNotice && <div className="import-notice" role="status">{importNotice}</div>}
            <input
              ref={imageInputRef}
              hidden
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                loadImageFile(event.target.files?.[0]).catch(() => undefined);
                event.target.value = '';
              }}
            />
          </div>

          <footer className="stage-footer">
            <span>{annotations.length} {annotations.length === 1 ? t('correction', 'correction') : t('corrections', 'corrections')}</span>
            <span>{imageSize.width ? imageSize.width + ' × ' + imageSize.height + t(' px · Wheel: zoom · right click: move', ' px · Molette : zoom · clic droit : déplacer') : t('No image', 'Aucune image')}</span>
            <div className="zoom-controls footer-zoom-controls">
              <button className="paste-shortcut" onClick={() => pasteMediaFromClipboard().catch(() => undefined)}>
                {t('Paste', 'Coller')} <kbd>Ctrl+V</kbd>
              </button>
              <i className="zoom-divider" />
              <button aria-label={t('Zoom out', 'Réduire le zoom')} onClick={() => changeZoom(zoomRef.current - 0.1)}>−</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button aria-label={t('Zoom in', 'Augmenter le zoom')} onClick={() => changeZoom(zoomRef.current + 0.1)}>+</button>
            </div>
            <span className="legal-status">
              {saveStatus}
              <a href="https://github.com/MrMybal/CyAnnota" target="_blank" rel="noreferrer">Source · AGPL-3.0</a>
            </span>
          </footer>
        </section>

        <aside className="inspector">
          <section className="panel-section layers-section">
            <div className="inspector-heading">
              <div>
                <p className="eyebrow">{t('ORGANIZATION', 'ORGANISATION')}</p>
                <h2>{t('Layers', 'Calques')}</h2>
              </div>
              <button className="icon-button" title={t('Add a layer', 'Ajouter un calque')} onClick={addLayer}>+</button>
            </div>

            <div className="layers-list">
              {layers.map((layer) => (
                <div
                  key={layer.id}
                  className={'layer-row ' + (activeLayerId === layer.id ? 'active' : '')}
                  onClick={() => setActiveLayerId(layer.id)}
                >
                  <input
                    type="color"
                    className="layer-color-input"
                    aria-label={t('Layer color ', 'Couleur du calque ') + layer.name}
                    value={layer.color}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const color = event.target.value;
                      setLayers((items) => items.map((item) => (item.id === layer.id ? { ...item, color } : item)));
                      replaceAnnotations(annotationsRef.current.map((annotation) => (annotation.layerId === layer.id ? { ...annotation, color } : annotation)));
                    }}
                  />
                  <button className="layer-name" onDoubleClick={() => renameLayer(layer)}>
                    <strong>{layer.name}</strong>
                    <span>{annotations.filter((annotation) => annotation.layerId === layer.id).length} {t('item(s)', 'élément(s)')}</span>
                  </button>
                  <button
                    className={'visibility ' + (layer.visible ? 'visible' : '')}
                    title={layer.visible ? t('Hide this layer', 'Masquer ce calque') : t('Show this layer', 'Afficher ce calque')}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleLayer(layer.id);
                    }}
                  >
                    {layer.visible ? '◉' : '○'}
                  </button>
                </div>
              ))}
            </div>
            <p className="micro-hint">{t('Double-click a layer name to rename it.', 'Double-clique le nom d’un calque pour le renommer.')}</p>
          </section>

          <section className="general-message">
            <label htmlFor="global-message">
              <span>{t('MAIN IMAGE MESSAGE', 'MESSAGE PRINCIPAL DE L’IMAGE')}</span>
              <small>{t('Included in the exported prompt for the whole image', 'Inclus dans le prompt exporté pour toute l’image')}</small>
            </label>
            <textarea
              id="global-message"
              value={globalInstructions}
              onChange={(event) => updateGlobalInstructions(event.target.value)}
              placeholder={t('Example: Keep the overall style, but make the screen clearer and more compact…', 'Ex. Je veux conserver le style général, mais rendre l’écran plus clair et plus compact…')}
            />
          </section>

          <section className="corrections-section">
            <div className="corrections-heading">
              <div>
                <p className="eyebrow">{t('ANNOTATIONS', 'ANNOTATIONS')}</p>
                <h2>{t('Corrections', 'Corrections')} <span>{annotations.length}</span></h2>
              </div>
            </div>

            <div className="corrections-list">
              {!annotations.length && (
                <div className="empty-notes">
                  <span>01</span>
                  <p>{t('Select a tool, then draw on the image to create your first correction.', 'Sélectionne un outil puis dessine sur l’image pour créer ta première correction.')}</p>
                </div>
              )}

              {annotations.map((annotation, index) => {
                const layer = layers.find((item) => item.id === annotation.layerId);
                return (
                  <button
                    key={annotation.id}
                    className={'correction-card ' + (selectedId === annotation.id ? 'selected' : '') + (!layer?.visible ? ' hidden-layer' : '')}
                    onClick={() => {
                      setSelectedId(annotation.id);
                      setActiveLayerId(annotation.layerId);
                      setTool('select');
                    }}
                  >
                    <span className="correction-number" style={{ background: annotation.color }}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="correction-copy">
                      <strong>{CATEGORY_LABELS[locale][annotation.category]} · {TYPE_LABELS[locale][annotation.type]}</strong>
                      <span>{annotation.description || t('Message to specify', 'Message à préciser')}</span>
                      {annotation.groupId && (
                        <em>
                          {t('In frame ', 'Dans cadre ')}{String(annotations.findIndex((item) => item.id === annotation.groupId) + 1).padStart(2, '0')}
                        </em>
                      )}
                    </span>
                    <span className="card-chevron">›</span>
                  </button>
                );
              })}
            </div>
          </section>

          {selected && (
            <section
              className={'annotation-editor ' + (isDraggingReference ? 'is-reference-dragging' : '')}
              onDragEnter={handleReferenceDragOver}
              onDragOver={handleReferenceDragOver}
              onDragLeave={handleReferenceDragLeave}
              onDrop={handleReferenceDrop}
            >
              {isDraggingReference && (
                <div className="reference-drop-overlay" aria-live="polite">
                  <span>＋</span>
                  <strong>{t('Add as reference', 'Ajouter comme référence')}</strong>
                  <small>{t('This image will remain linked only to this correction.', 'Cette image restera liée uniquement à cette correction.')}</small>
                </div>
              )}
              <div className="editor-heading">
                <div>
                  <p className="eyebrow">CORRECTION {String(annotations.findIndex((item) => item.id === selected.id) + 1).padStart(2, '0')}</p>
                  <h3>{TYPE_LABELS[locale][selected.type]}</h3>
                </div>
                <button className="close-editor" title={t('Close', 'Fermer')} onClick={() => setSelectedId(null)}>×</button>
              </div>

              <div className="form-grid">
                <label>
                  <span>{t('Action', 'Action')}</span>
                  <select
                    value={selected.category}
                    onChange={(event) => updateAnnotation(selected.id, { category: event.target.value as Category })}
                  >
                    {(Object.keys(CATEGORY_LABELS[locale]) as Category[]).map((category) => (
                      <option key={category} value={category}>{CATEGORY_LABELS[locale][category]}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t('Layer', 'Calque')}</span>
                  <select
                    value={selected.layerId}
                    onChange={(event) => {
                      const layer = layers.find((item) => item.id === event.target.value);
                      updateAnnotation(selected.id, {
                        layerId: event.target.value,
                        color: layer?.color || selected.color,
                      });
                    }}
                  >
                    {layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
                  </select>
                </label>
              </div>

              {selected.type !== 'frame' && (
                <label className="group-field">
                  <span>{t('Linked frame', 'Cadre associé')}</span>
                  <select
                    value={selected.groupId || ''}
                    onChange={(event) =>
                      updateAnnotation(selected.id, { groupId: event.target.value || undefined })
                    }
                  >
                    <option value="">{t('No frame', 'Aucun cadre')}</option>
                    {annotations
                      .filter((annotation): annotation is FrameAnnotation => annotation.type === 'frame')
                      .map((frame) => (
                        <option key={frame.id} value={frame.id}>
                          {t('Frame ', 'Cadre ')}{String(annotations.findIndex((item) => item.id === frame.id) + 1).padStart(2, '0')}
                        </option>
                      ))}
                  </select>
                </label>
              )}

              {selected.type === 'frame' && (
                <div className="frame-summary">
                  <span>{t('Active group', 'Groupe actif')}</span>
                  <strong>
                    {annotations.filter((annotation) => annotation.groupId === selected.id).length} {t('linked item(s)', 'élément(s) lié(s)')}
                  </strong>
                  <small>{t('Shapes and notes created in this frame are grouped automatically.', 'Les formes et notes créées dans ce cadre sont automatiquement regroupées.')}</small>
                </div>
              )}

              {selected.type === 'shape' && (
                <div className="shape-controls">
                  <label>
                    <span>{t('Shape', 'Forme')}</span>
                    <select
                      value={selected.shape}
                      onChange={(event) =>
                        updateAnnotation(selected.id, {
                          shape: event.target.value as ShapeAnnotation['shape'],
                        })
                      }
                    >
                      <option value="rectangle">Rectangle</option>
                      <option value="ellipse">Ellipse</option>
                      <option value="line">{t('Line', 'Ligne')}</option>
                    </select>
                  </label>
                  <label>
                    <span>{t('Fill', 'Remplissage')}</span>
                    <input
                      type="color"
                      value={selected.fillColor}
                      onChange={(event) =>
                        updateAnnotation(selected.id, { fillColor: event.target.value })
                      }
                    />
                  </label>
                </div>
              )}

              {selected.type === 'color' && (
                <div className="color-replacement">
                  <div>
                    <span>{t('Sampled color', 'Couleur prélevée')}</span>
                    <input
                      type="color"
                      value={selected.sampledColor}
                      onChange={(event) =>
                        updateAnnotation(selected.id, { sampledColor: event.target.value })
                      }
                    />
                    <code>{selected.sampledColor.toUpperCase()}</code>
                  </div>
                  <b>→</b>
                  <div>
                    <span>{t('Requested color', 'Couleur souhaitée')}</span>
                    <input
                      type="color"
                      value={selected.replacementColor}
                      onChange={(event) =>
                        updateAnnotation(selected.id, { replacementColor: event.target.value })
                      }
                    />
                    <code>{selected.replacementColor.toUpperCase()}</code>
                  </div>
                </div>
              )}

              <label className="message-field" data-reference-paste="true">
                <span>{t('Message linked to the image', 'Message lié à l’image')}</span>
                <textarea
                  value={selected.description}
                  onChange={(event) => updateAnnotation(selected.id, { description: event.target.value })}
                  placeholder={t('Explain exactly what you want to change here…', 'Explique exactement ce que tu veux changer ici…')}
                />
              </label>

              {selected.type === 'cut' && (
                <div className="cut-summary">
                  <span>{selected.polygon?.length ? t('Movable polygon cutout', 'Découpe polygonale déplaçable') : t('Movable cutout', 'Découpe déplaçable')}</span>
                  <strong>Δx {Math.round(selected.x - selected.sourceX)} px · Δy {Math.round(selected.y - selected.sourceY)} px</strong>
                  <small>{t('Select the ↖ tool and drag the item over the image.', 'Sélectionne l’outil ↖ et fais glisser l’élément sur l’image.')}</small>
                </div>
              )}

              {selected.type === 'resize' && (
                <div className="resize-controls">
                  <div className="resize-heading">
                    <span>{t('SIZE FRAME', 'CADRE SIZE')}</span>
                    <strong>{Math.round(selected.sourceW)}×{Math.round(selected.sourceH)} → {Math.round(selected.w)}×{Math.round(selected.h)} px</strong>
                  </div>
                  <div className="resize-dimensions">
                    <label>
                      <span>{t('Width', 'Largeur')}</span>
                      <input
                        type="number" min="8" step="1" value={Math.round(selected.w)}
                        onChange={(event) => {
                          const width = Math.max(8, Number(event.target.value) || 8);
                          updateAnnotation(selected.id, {
                            w: width,
                            h: selected.lockAspectRatio
                              ? Math.max(8, Math.round(width * selected.sourceH / selected.sourceW))
                              : selected.h,
                          });
                        }}
                      />
                    </label>
                    <label>
                      <span>{t('Height', 'Hauteur')}</span>
                      <input
                        type="number" min="8" step="1" value={Math.round(selected.h)}
                        onChange={(event) => {
                          const height = Math.max(8, Number(event.target.value) || 8);
                          updateAnnotation(selected.id, {
                            h: height,
                            w: selected.lockAspectRatio
                              ? Math.max(8, Math.round(height * selected.sourceW / selected.sourceH))
                              : selected.w,
                          });
                        }}
                      />
                    </label>
                  </div>
                  <label className="resize-ratio">
                    <input type="checkbox" checked={selected.lockAspectRatio} onChange={(event) => updateAnnotation(selected.id, { lockAspectRatio: event.target.checked })} />
                    <span>{t('Keep aspect ratio', 'Conserver les proportions')}</span>
                  </label>
                  <div className="resize-presets">
                    {[50, 75, 100, 125, 150, 200].map((percent) => (
                      <button key={percent} type="button" onClick={() => updateAnnotation(selected.id, {
                        w: Math.max(8, Math.round(selected.sourceW * percent / 100)),
                        h: Math.max(8, Math.round(selected.sourceH * percent / 100)),
                      })}>{percent}%</button>
                    ))}
                  </div>
                  <small>{t('Drag the white handle on the image or enter exact target dimensions.', 'Fais glisser la poignée blanche sur l’image ou saisis les dimensions cibles exactes.')}</small>
                </div>
              )}

              <div className="references" data-reference-paste="true">
                <div className="references-heading">
                  <div>
                    <span>{t('Reference images', 'Images de référence')}</span>
                    <small>{selected.type === 'frame' ? t('Linked to this frame · drop or Ctrl+V in the message', 'Liées à ce cadre · dépôt ou Ctrl+V dans le message') : t('Linked to this correction · drop or Ctrl+V in the message', 'Liées à cette correction · dépôt ou Ctrl+V dans le message')}</small>
                  </div>
                  <button className="mini-button" onClick={() => referenceInputRef.current?.click()}>+ {t('Add', 'Ajouter')}</button>
                </div>

                <input
                  ref={referenceInputRef}
                  hidden
                  multiple
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    addReferences(event.target.files).catch(() => undefined);
                    event.target.value = '';
                  }}
                />

                {!!selected.references.length && (
                  <div className="reference-grid">
                    {selected.references.map((reference) => (
                      <div className="reference-item" key={reference.id}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={reference.dataUrl} alt={reference.name} />
                        <button title={t('Remove this reference', 'Retirer cette référence')} onClick={() => removeReference(reference.id)}>×</button>
                        <span>{reference.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button className="delete-button" onClick={deleteSelected}>{t('Delete this correction', 'Supprimer cette correction')}</button>
            </section>
          )}
        </aside>
      </section>

      {renderExportDialog()}
      {renderWorkspaceMessageDialog()}
    </main>
  );
}
