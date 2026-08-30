'use client';

import JSZip from 'jszip';
import {
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppLocale, DEFAULT_LOCALE, translate } from './i18n';
import VersionStatus from './version-status';

type Point = { x: number; y: number };
export type VideoAnnotationType = 'rect' | 'arrow' | 'note' | 'draw';
export type VideoOutputFormat = 'mp4' | 'gif';

export type VideoAnnotation = {
  id: string;
  type: VideoAnnotationType;
  start: number;
  end: number;
  color: string;
  message: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  x2?: number;
  y2?: number;
  points?: Point[];
  snapshot?: string;
};

export type VideoFrameStop = {
  id: string;
  time: number;
  frameIndex?: number;
  imageData: string;
  annotations?: VideoAnnotation[];
};

export type VideoProjectData = {
  version: 1;
  kind: 'video';
  title: string;
  videoName: string;
  videoType: string;
  duration: number;
  sourcePath: string;
  generalInstructions: string;
  annotations: VideoAnnotation[];
  frameStops?: VideoFrameStop[];
  trimStart?: number;
  trimEnd?: number;
  trimmedPath?: string;
  originalSourcePath?: string;
  originalIncluded?: boolean;
  sourceTrimStart?: number;
  sourceTrimEnd?: number;
};

type VideoWorkspaceProps = {
  file: File;
  initialProject?: VideoProjectData;
  onClose?: () => void;
  onSaveBlob: (blob: Blob, name: string) => Promise<boolean>;
  onProjectChange?: (project: VideoProjectData) => void;
  onCaptureFrame?: (file: File, time: number) => Promise<void> | void;
  tabBar?: ReactNode;
  onOpenWorkspace?: () => void;
  onAddImage?: () => void;
  onAddVideo?: () => void;
  onSaveWorkspace?: () => void;
  onExportWorkspace?: () => void;
  onEditWorkspaceMessage?: () => void;
  workspaceInstructions?: string;
  workspaceStatus?: string;
  workspaceBusy?: boolean;
  locale: AppLocale;
  onLocaleChange: (locale: AppLocale) => void;
};

type VideoTool = 'select' | 'pan' | VideoAnnotationType;
type VideoDraft = {
  type: VideoAnnotationType;
  x: number;
  y: number;
  x2: number;
  y2: number;
  points: Point[];
};
type CompressionQuality = 'high' | 'balanced' | 'light';
type TimelineResizeState = {
  annotationId: string;
  start: number;
  pointerId: number;
  timeline: HTMLDivElement;
};

type TimelineMoveState = {
  annotationId: string;
  start: number;
  end: number;
  pointerStartX: number;
  pointerId: number;
  timeline: HTMLDivElement;
  didMove: boolean;
};

const VIDEO_TOOL_LABELS: Record<AppLocale, Record<VideoTool, string>> = {
  en: {
    select: 'Select an annotation',
    pan: 'Hand — move the video',
    rect: 'Frame an area',
    arrow: 'Draw an arrow',
    note: 'Place a note',
    draw: 'Draw freely',
  },
  fr: {
    select: 'Sélectionner une correction',
    pan: 'Main — déplacer la vidéo',
    rect: 'Encadrer une zone',
    arrow: 'Tracer une flèche',
    note: 'Placer une note',
    draw: 'Dessiner librement',
  },
};

const VIDEO_TOOL_ICONS: Record<VideoTool, string> = {
  select: '↖',
  pan: '✥',
  rect: '□',
  arrow: '↗',
  note: 'T',
  draw: '✎',
};

function createId() {
  return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
}

function safeFileName(value: string) {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'video'
  );
}

function formatTime(value: number, milliseconds = false) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const fraction = Math.floor((safe % 1) * 1000);
  const base =
    (hours ? String(hours).padStart(2, '0') + ':' : '') +
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0');
  return milliseconds ? base + '.' + String(fraction).padStart(3, '0') : base;
}

function dataUrlPayload(dataUrl: string) {
  const separator = dataUrl.indexOf(',');
  return separator >= 0 ? dataUrl.slice(separator + 1) : '';
}

async function bytesToDataUrl(bytes: Uint8Array, mimeType: string) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([buffer], { type: mimeType });
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Conversion de la frame impossible'));
    reader.readAsDataURL(blob);
  });
}

async function createLocalFfmpegResources() {
  const baseUrl = new URL('./ffmpeg/', window.location.href);
  const manifestResponse = await fetch(
    new URL('ffmpeg-core.wasm.parts.json', baseUrl),
    { cache: 'force-cache' },
  );
  if (!manifestResponse.ok) throw new Error('Manifest FFmpeg local introuvable');
  const manifest = await manifestResponse.json() as {
    version?: unknown;
    size?: unknown;
    parts?: unknown;
  };
  if (manifest.version !== 1 || typeof manifest.size !== 'number'
    || manifest.size < 1 || manifest.size > 64 * 1024 * 1024
    || !Array.isArray(manifest.parts) || manifest.parts.length < 1
    || manifest.parts.length > 16
    || manifest.parts.some((name) =>
      typeof name !== 'string' || !/^ffmpeg-core\.wasm\.part\d+$/.test(name))) {
    throw new Error('Manifest FFmpeg local invalide');
  }
  const chunks = await Promise.all(manifest.parts.map(async (name) => {
    const response = await fetch(new URL(name as string, baseUrl), { cache: 'force-cache' });
    if (!response.ok) throw new Error('Bloc FFmpeg local manquant');
    return response.arrayBuffer();
  }));
  const wasm = new Blob(chunks, { type: 'application/wasm' });
  if (wasm.size !== manifest.size) throw new Error('Moteur FFmpeg local incomplet');
  return { baseUrl, wasmUrl: URL.createObjectURL(wasm) };
}

function videoSelectionPath(
  project: Pick<VideoProjectData, 'videoName'>,
  outputFormat: VideoOutputFormat = 'mp4',
) {
  const baseName = project.videoName.replace(/\.[^.]+$/, '') || 'video';
  return 'media/selection-' + safeFileName(baseName) + '.' + outputFormat;
}

export function videoTrimBounds(project: Pick<VideoProjectData, 'duration' | 'trimStart' | 'trimEnd'>) {
  const duration = Number.isFinite(project.duration) ? Math.max(0, project.duration) : 0;
  const start = Math.max(0, Math.min(duration, Number.isFinite(project.trimStart) ? project.trimStart as number : 0));
  const requestedEnd = Number.isFinite(project.trimEnd) ? project.trimEnd as number : duration;
  const end = Math.max(start, Math.min(duration, requestedEnd));
  return { start, end: end > start ? end : duration, duration: Math.max(0, (end > start ? end : duration) - start) };
}

export function createVideoDeliveryProject(
  project: VideoProjectData,
  originalIncluded = false,
  outputFormat: VideoOutputFormat = 'mp4',
) {
  const bounds = videoTrimBounds(project);
  const trimmedPath = videoSelectionPath(project, outputFormat);
  const annotations = project.annotations
    .filter((annotation) => annotation.end > bounds.start && annotation.start < bounds.end)
    .map((annotation) => ({
      ...annotation,
      start: Math.max(0, Math.max(annotation.start, bounds.start) - bounds.start),
      end: Math.max(0.01, Math.min(annotation.end, bounds.end) - bounds.start),
    }));
  const frameStops = (project.frameStops || [])
    .filter((stop) => stop.time >= bounds.start && stop.time <= bounds.end)
    .map((stop) => ({
      ...stop,
      time: Math.max(0, stop.time - bounds.start),
      annotations: (stop.annotations || []).map((annotation) => ({
        ...annotation,
        start: Math.max(0, annotation.start - bounds.start),
        end: Math.max(0, annotation.end - bounds.start),
      })),
    }));
  return {
    ...project,
    videoName: safeFileName(project.videoName.replace(/\.[^.]+$/, '') || 'video') + '-selection.' + outputFormat,
    videoType: outputFormat === 'gif' ? 'image/gif' : 'video/mp4',
    duration: bounds.duration,
    sourcePath: trimmedPath,
    trimmedPath,
    originalSourcePath: project.sourcePath,
    originalIncluded,
    sourceTrimStart: bounds.start,
    sourceTrimEnd: bounds.end,
    trimStart: 0,
    trimEnd: bounds.duration,
    annotations,
    frameStops,
  } satisfies VideoProjectData;
}

export async function encodeTrimmedVideo(
  file: File,
  start: number,
  end: number,
  onProgress?: (progress: number) => void,
  outputFormat: VideoOutputFormat = 'mp4',
) {
  if (file.size >= 2 * 1024 * 1024 * 1024) {
    throw new Error('L’encodage local accepte des vidéos de moins de 2 Go.');
  }
  const clipDuration = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || clipDuration < 0.05) {
    throw new Error('La plage de découpe doit conserver au moins 0,05 seconde.');
  }
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => {
    if (Number.isFinite(progress)) onProgress?.(Math.max(0, Math.min(99, Math.round(progress * 100))));
  });
  const extension = file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'video';
  const inputName = 'trim-input-' + createId() + '.' + extension;
  const outputName = 'trim-output-' + createId() + '.' + outputFormat;
  let wasmUrl: string | null = null;
  try {
    const resources = await createLocalFfmpegResources();
    wasmUrl = resources.wasmUrl;
    await ffmpeg.load({
      coreURL: new URL('ffmpeg-core.js', resources.baseUrl).href,
      wasmURL: wasmUrl,
    });
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
    const outputArgs = outputFormat === 'gif'
      ? [
          '-filter_complex',
          '[0:v]split[source][paletteSource];[paletteSource]palettegen=stats_mode=diff[palette];[source][palette]paletteuse=dither=sierra2_4a[gif]',
          '-map', '[gif]',
          '-loop', '0',
        ]
      : [
          '-map', '0:v:0',
          '-map', '0:a?',
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '24',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-avoid_negative_ts', 'make_zero',
          '-movflags', '+faststart',
        ];
    const exitCode = await ffmpeg.exec([
      '-i', inputName,
      '-ss', start.toFixed(6),
      '-t', clipDuration.toFixed(6),
      ...outputArgs,
      outputName,
    ]);
    if (exitCode !== 0) throw new Error('Le moteur vidéo a terminé avec le code ' + exitCode + '.');
    const output = await ffmpeg.readFile(outputName);
    if (typeof output === 'string') throw new Error('La vidéo découpée générée est invalide.');
    const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
    onProgress?.(100);
    return new Blob([buffer], { type: outputFormat === 'gif' ? 'image/gif' : 'video/mp4' });
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => undefined);
    await ffmpeg.deleteFile(outputName).catch(() => undefined);
    ffmpeg.terminate();
    if (wasmUrl) URL.revokeObjectURL(wasmUrl);
  }
}

function annotationBounds(annotation: VideoAnnotation | VideoDraft) {
  if (annotation.type === 'draw') {
    const points = annotation.points || [];
    if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  const x = annotation.x || 0;
  const y = annotation.y || 0;
  const x2 = annotation.x2 ?? x;
  const y2 = annotation.y2 ?? y;
  return {
    x: Math.min(x, x2),
    y: Math.min(y, y2),
    w: Math.abs(x2 - x),
    h: Math.abs(y2 - y),
  };
}

function drawArrow(context: CanvasRenderingContext2D, a: Point, b: Point, color: string, width: number) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = Math.max(10, width * 5);
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.lineTo(b.x, b.y);
  context.strokeStyle = color;
  context.lineWidth = width;
  context.stroke();
  context.beginPath();
  context.moveTo(b.x, b.y);
  context.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
  context.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
  context.closePath();
  context.fillStyle = color;
  context.fill();
}

function paintVideoAnnotation(
  context: CanvasRenderingContext2D,
  annotation: VideoAnnotation | VideoDraft,
  index: number,
  selected = false,
) {
  const color = 'color' in annotation ? annotation.color : '#ff5c49';
  const unit = Math.max(1, context.canvas.width / 1100);
  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = (selected ? 4 : 3) * unit;

  if (annotation.type === 'rect') {
    const bounds = annotationBounds(annotation);
    context.fillStyle = color + '20';
    context.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    context.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
  } else if (annotation.type === 'arrow') {
    drawArrow(
      context,
      { x: annotation.x || 0, y: annotation.y || 0 },
      { x: annotation.x2 || 0, y: annotation.y2 || 0 },
      color,
      context.lineWidth,
    );
  } else if (annotation.type === 'draw') {
    const points = annotation.points || [];
    if (points.length > 1) {
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
  } else {
    const x = annotation.x || 0;
    const y = annotation.y || 0;
    context.beginPath();
    context.arc(x, y, 15 * unit, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#181513';
    context.font = `800 ${10 * unit}px Segoe UI`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(index + 1).padStart(2, '0'), x, y);
  }

  if ('id' in annotation && annotation.type !== 'note') {
    const bounds = annotationBounds(annotation);
    const badgeX = bounds.x;
    const badgeY = Math.max(0, bounds.y - 25 * unit);
    context.fillStyle = color;
    context.fillRect(badgeX, badgeY, 31 * unit, 21 * unit);
    context.fillStyle = '#181513';
    context.font = `850 ${9 * unit}px Segoe UI`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(index + 1).padStart(2, '0'), badgeX + 15.5 * unit, badgeY + 10.5 * unit);
  }
  context.restore();
}

function hitAnnotation(annotation: VideoAnnotation, point: Point) {
  if (annotation.type === 'note') {
    return Math.hypot(point.x - (annotation.x || 0), point.y - (annotation.y || 0)) <= 28;
  }
  const bounds = annotationBounds(annotation);
  const padding = 16;
  return (
    point.x >= bounds.x - padding &&
    point.x <= bounds.x + bounds.w + padding &&
    point.y >= bounds.y - padding &&
    point.y <= bounds.y + bounds.h + padding
  );
}

export function videoFrameStopFileName(stop: Pick<VideoFrameStop, 'time' | 'frameIndex'>, index: number) {
  const sourceFrame = stop.frameIndex === undefined
    ? ''
    : '-source-' + String(stop.frameIndex + 1).padStart(6, '0');
  return String(index + 1).padStart(2, '0') + '-frame' + sourceFrame + '-' + formatTime(stop.time, true).replace(/[:.]/g, '-') + '.png';
}

export function videoFrameStopAnnotatedFileName(stop: Pick<VideoFrameStop, 'time' | 'frameIndex'>, index: number) {
  return videoFrameStopFileName(stop, index).replace(/\.png$/i, '-annotated.png');
}

export async function renderAnnotatedVideoFrameStop(stop: VideoFrameStop) {
  if (!stop.annotations?.length) return null;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Impossible de relire la frame PNG annotée.'));
    image.src = stop.imageData;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas indisponible pour la frame annotée.');
  context.drawImage(image, 0, 0);
  stop.annotations.forEach((annotation, index) => paintVideoAnnotation(context, annotation, index));
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Impossible de générer la frame annotée.')),
      'image/png',
    );
  });
}

export function buildVideoPrompt(project: VideoProjectData, locale: AppLocale = DEFAULT_LOCALE) {
  const t = (english: string, french: string) => translate(locale, english, french);
  const frameStops = [...(project.frameStops || [])].sort((a, b) => a.time - b.time);
  const isDeliveryProject = project.sourceTrimStart !== undefined || project.sourceTrimEnd !== undefined;
  const bounds = videoTrimBounds(project);
  const sourceTrimStart = isDeliveryProject ? project.sourceTrimStart ?? 0 : bounds.start;
  const sourceTrimEnd = isDeliveryProject ? project.sourceTrimEnd ?? project.duration : bounds.end;
  const lines = [
    t('# Video correction brief — ', '# Brief de corrections vidéo — ') + project.title,
    '',
    isDeliveryProject
      ? t('Apply the timed corrections below to the trimmed and encoded video “', 'Applique les corrections temporelles ci-dessous à la vidéo découpée et encodée « ') + project.sourcePath + t('”.', ' ».')
      : t('Apply the timed corrections below to the source video “', 'Applique les corrections temporelles ci-dessous à la vidéo source « ') + project.sourcePath + t('”.', ' ».'),
    '',
    isDeliveryProject ? t('## Provided cut', '## Découpe fournie') : t('## Cut to produce', '## Découpe à produire'),
    '',
    t('- Segment kept from the source: ', '- Portion conservée depuis la source : ') + formatTime(sourceTrimStart, true) + ' → ' + formatTime(sourceTrimEnd, true) + '.',
    isDeliveryProject
      ? t('- Provided video duration: ', '- Durée de la vidéo fournie : ') + formatTime(project.duration, true) + '.'
      : t('- Source video duration: ', '- Durée de la vidéo source : ') + formatTime(project.duration, true) + '.',
    isDeliveryProject
      ? t('- The timecodes below are relative to the start of the trimmed video.', '- Les timecodes ci-dessous sont relatifs au début de la vidéo découpée.')
      : t('- The timecodes below remain relative to the complete source video.', '- Les timecodes ci-dessous restent relatifs à la vidéo source complète.'),
    isDeliveryProject
      ? project.originalIncluded
        ? t('- The original source video is also included as reference data.', '- La vidéo source originale est également jointe comme donnée de référence.')
        : t('- The original source video is not included in this lightweight package.', '- La vidéo source originale n’est pas incluse dans ce paquet léger.')
      : t('- The encoded trimmed version is included at “', '- La version découpée encodée est jointe sous « ') + (project.trimmedPath || videoSelectionPath(project)) + t('”, and the original source remains included.', ' » et la source originale reste incluse.'),
    '',
    t('## General intent', '## Intention générale'),
    '',
    project.generalInstructions.trim() || t('No additional general instruction.', 'Aucune instruction générale supplémentaire.'),
    '',
    t('## Timed corrections', '## Corrections temporelles'),
    '',
  ];
  project.annotations.forEach((annotation, index) => {
    const bounds = annotationBounds(annotation);
    lines.push(
      '### ' + String(index + 1).padStart(2, '0') + ' — ' + formatTime(annotation.start, true) + ' → ' + formatTime(annotation.end, true),
      '',
      t('- Type: ', '- Type : ') + VIDEO_TOOL_LABELS[locale][annotation.type],
      t('- Area: x=', '- Zone : x=') + Math.round(bounds.x) + ', y=' + Math.round(bounds.y) + t(', width=', ', largeur=') + Math.round(bounds.w) + t(', height=', ', hauteur=') + Math.round(bounds.h),
      t('- Instruction: ', '- Instruction : ') + (annotation.message.trim() || t('Instruction to specify.', 'Instruction à préciser.')),
      t('- Capture: captures/', '- Capture : captures/') + String(index + 1).padStart(2, '0') + '-annotation.png',
      '',
    );
  });
  if (!project.annotations.length) lines.push(t('No timed correction was annotated.', 'Aucune correction temporelle annotée.'), '');
  lines.push(t('## Frame stops', '## Arrêts sur image'), '');
  frameStops.forEach((stop, index) => {
    const stopAnnotations = stop.annotations || [];
    lines.push(
      '### Frame ' + String(index + 1).padStart(2, '0') + ' — ' + formatTime(stop.time, true),
      '',
      t('- Exported image: frames/', '- Image exportée : frames/') + videoFrameStopFileName(stop, index),
      ...(stopAnnotations.length
        ? [t('- Annotated image: frames/', '- Image avec annotations : frames/') + videoFrameStopAnnotatedFileName(stop, index)]
        : []),
      ...(stop.frameIndex === undefined
        ? [t('- Stop created directly from the video at this timecode.', '- Arrêt créé directement depuis la vidéo à ce timecode.')]
        : [t('- Exact source frame: #', '- Frame source exacte : #') + (stop.frameIndex + 1) + t(' (decoded index ', ' (index décodé ') + stop.frameIndex + ').']),
      t('- Use this image as a standalone capture of the video at this instant.', '- Utiliser cette image comme capture autonome de la vidéo à cet instant.'),
      ...stopAnnotations.map((annotation, annotationIndex) =>
        t('- Correction ', '- Correction ') + String(annotationIndex + 1).padStart(2, '0') + ' · ' + VIDEO_TOOL_LABELS[locale][annotation.type] + t(': ', ' : ') + (annotation.message.trim() || t('Instruction to specify.', 'Instruction à préciser.'))
      ),
      '',
    );
  });
  if (!frameStops.length) lines.push(t('No frame stop requested.', 'Aucun arrêt sur image demandé.'), '');
  lines.push(
    t('## Completion criteria', '## Critère de fin'),
    '',
    t('Respect the timecodes and preserve every sequence that is not explicitly affected.', 'Respecter les timecodes et conserver toutes les séquences qui ne sont pas explicitement concernées.'),
  );
  return lines.join('\n');
}
export default function VideoAnnotator({
  file,
  initialProject,
  onClose,
  onSaveBlob,
  onProjectChange,
  onCaptureFrame,
  tabBar,
  onOpenWorkspace,
  onAddImage,
  onAddVideo,
  onSaveWorkspace,
  onExportWorkspace,
  onEditWorkspaceMessage,
  workspaceInstructions = '',
  workspaceStatus,
  workspaceBusy = false,
  locale,
  onLocaleChange,
}: VideoWorkspaceProps) {
  const isGifSource = file.type.toLowerCase() === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
  const t = (english: string, french: string) => translate(locale, english, french);
  const [originalSourceUrl] = useState(() => URL.createObjectURL(file));
  const [playbackUrl, setPlaybackUrl] = useState(originalSourceUrl);
  const [title, setTitle] = useState(
    initialProject?.title || file.name.replace(/\.[^.]+$/, '') || t('Video corrections', 'Corrections vidéo'),
  );
  const [generalInstructions, setGeneralInstructions] = useState(
    initialProject?.generalInstructions || '',
  );
  const [annotations, setAnnotations] = useState<VideoAnnotation[]>(
    initialProject?.annotations || [],
  );
  const [frameStops, setFrameStops] = useState<VideoFrameStop[]>(() =>
    [...(initialProject?.frameStops || [])].sort((a, b) => a.time - b.time),
  );
  const [selectedFrameStopId, setSelectedFrameStopId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<VideoTool>('rect');
  const [draft, setDraft] = useState<VideoDraft | null>(null);
  const [duration, setDuration] = useState(initialProject?.duration || 0);
  const [trimStart, setTrimStart] = useState(() => Math.max(0, initialProject?.trimStart || 0));
  const [trimEnd, setTrimEnd] = useState(() => Math.max(0, initialProject?.trimEnd ?? initialProject?.duration ?? 0));
  const [videoSize, setVideoSize] = useState({ width: 16, height: 9 });
  const [videoError, setVideoError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [resizingAnnotationId, setResizingAnnotationId] = useState<string | null>(null);
  const [movingAnnotationId, setMovingAnnotationId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState(() => translate(locale, 'Ready', 'Prêt'));
  const [compressionOpen, setCompressionOpen] = useState(false);
  const [compressionQuality, setCompressionQuality] = useState<CompressionQuality>('balanced');
  const [compressionProgress, setCompressionProgress] = useState(0);
  const [compressionStatus, setCompressionStatus] = useState(() => translate(locale, 'Engine ready to load', 'Moteur prêt à charger'));
  const [isCompressing, setIsCompressing] = useState(false);
  const [isPreparingPreview, setIsPreparingPreview] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewStatus, setPreviewStatus] = useState(() => translate(locale, 'Compatible preview ready to create', 'Aperçu compatible prêt à créer'));
  const [hasCompatiblePreview, setHasCompatiblePreview] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<'timeline' | 'capture' | 'step'>('timeline');
  const [isExtractingFrame, setIsExtractingFrame] = useState(false);
  const [isSteppingFrame, setIsSteppingFrame] = useState(false);
  const [viewZoom, setViewZoom] = useState(1);
  const [viewPan, setViewPan] = useState<Point>({ x: 0, y: 0 });
  const [isViewPanning, setIsViewPanning] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef<VideoDraft | null>(null);
  const ffmpegRef = useRef<import('@ffmpeg/ffmpeg').FFmpeg | null>(null);
  const ffmpegWasmUrlRef = useRef<string | null>(null);
  const compressionCanceledRef = useRef(false);
  const automaticGifPreviewStartedRef = useRef(false);
  const previewCanceledRef = useRef(false);
  const ffmpegOperationRef = useRef<'preview' | 'compression' | 'frame' | null>(null);
  const compatiblePreviewUrlRef = useRef<string | null>(null);
  const videoStageRef = useRef<HTMLDivElement>(null);
  const videoFrameRef = useRef<HTMLDivElement>(null);
  const presentedFrameTimeRef = useRef(0);
  const presentedFrameDurationRef = useRef(1 / 60);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const viewZoomRef = useRef(1);
  const viewPanRef = useRef<Point>({ x: 0, y: 0 });
  const viewPanDragRef = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);
  const onProjectChangeRef = useRef(onProjectChange);
  const timelineResizeRef = useRef<TimelineResizeState | null>(null);
  const timelineMoveRef = useRef<TimelineMoveState | null>(null);
  const suppressTimelineClickRef = useRef(false);

  const selectedFrameStop = frameStops.find((stop) => stop.id === selectedFrameStopId) || null;
  const activeAnnotations = useMemo(
    () => workspaceMode === 'step' ? selectedFrameStop?.annotations || [] : workspaceMode === 'timeline' ? annotations : [],
    [annotations, selectedFrameStop, workspaceMode],
  );
  const selected = activeAnnotations.find((annotation) => annotation.id === selectedId) || null;
  const effectiveTrimEnd = trimEnd > trimStart ? trimEnd : duration;
  const keptDuration = Math.max(0, effectiveTrimEnd - trimStart);
  const visibleAnnotations = useMemo(
    () => workspaceMode === 'timeline'
      ? annotations.filter((annotation) => currentTime >= annotation.start && currentTime <= annotation.end)
      : workspaceMode === 'step' ? selectedFrameStop?.annotations || [] : [],
    [annotations, currentTime, selectedFrameStop, workspaceMode],
  );

  function requestLocaleChange(nextLocale: AppLocale) {
    setSaveStatus((current) =>
      current === 'Ready' || current === 'Prêt'
        ? translate(nextLocale, 'Ready', 'Prêt')
        : current,
    );
    setCompressionStatus((current) =>
      current === 'Engine ready to load' || current === 'Moteur prêt à charger'
        ? translate(nextLocale, 'Engine ready to load', 'Moteur prêt à charger')
        : current,
    );
    setPreviewStatus((current) =>
      current === 'Compatible preview ready to create' || current === 'Aperçu compatible prêt à créer'
        ? translate(nextLocale, 'Compatible preview ready to create', 'Aperçu compatible prêt à créer')
        : current,
    );
    onLocaleChange(nextLocale);
  }

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      URL.revokeObjectURL(originalSourceUrl);
      if (compatiblePreviewUrlRef.current) URL.revokeObjectURL(compatiblePreviewUrlRef.current);
      if (ffmpegWasmUrlRef.current) URL.revokeObjectURL(ffmpegWasmUrlRef.current);
      if (video && videoFrameCallbackRef.current !== null && 'cancelVideoFrameCallback' in video) {
        video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
      }
      ffmpegRef.current?.terminate();
    };
  }, [originalSourceUrl]);

  useEffect(() => {
    onProjectChangeRef.current = onProjectChange;
  }, [onProjectChange]);

  useEffect(() => {
    if (!isGifSource || automaticGifPreviewStartedRef.current) return;
    automaticGifPreviewStartedRef.current = true;
    setVideoError(t('Preparing the animated GIF for timeline playback…', 'Préparation du GIF animé pour la timeline…'));
    createCompatiblePreview().catch(() => undefined);
    // createCompatiblePreview is intentionally started once for this source file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGifSource]);

  useEffect(() => {
    viewZoomRef.current = viewZoom;
  }, [viewZoom]);

  useEffect(() => {
    viewPanRef.current = viewPan;
  }, [viewPan]);

  useEffect(() => {
    onProjectChangeRef.current?.(projectData());
  }, [title, generalInstructions, annotations, frameStops, duration, trimStart, trimEnd, file.name, file.type]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    visibleAnnotations.forEach((annotation, index) => {
      paintVideoAnnotation(context, annotation, index, annotation.id === selectedId);
    });
    if (draft) paintVideoAnnotation(context, draft, activeAnnotations.length, true);
  }, [activeAnnotations.length, draft, selectedId, videoSize.height, videoSize.width, visibleAnnotations]);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
    }, 40);
    return () => window.clearInterval(timer);
  }, [isPlaying]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.matches('input, textarea, select')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        togglePlayback();
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault();
        deleteSelected();
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (workspaceMode === 'step') stepVideoFrame(-1).catch(() => undefined);
        else seek(currentTime - (event.shiftKey ? 5 : 0.1));
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (workspaceMode === 'step') stepVideoFrame(1).catch(() => undefined);
        else seek(currentTime + (event.shiftKey ? 5 : 0.1));
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function restoreVideoSurfaceSize() {
    const video = videoRef.current;
    const canvas = overlayRef.current;
    if (!video?.videoWidth || !video.videoHeight || !canvas) return;
    setVideoSize({ width: video.videoWidth, height: video.videoHeight });
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  function changeViewZoom(nextValue: number, clientX?: number, clientY?: number) {
    const nextZoom = Math.max(0.25, Math.min(6, nextValue));
    const frame = videoFrameRef.current;
    const stage = videoStageRef.current;
    if (!frame || !stage) {
      viewZoomRef.current = nextZoom;
      setViewZoom(nextZoom);
      return;
    }
    const frameBounds = frame.getBoundingClientRect();
    const stageBounds = stage.getBoundingClientRect();
    const focusX = clientX ?? stageBounds.left + stage.clientWidth / 2;
    const focusY = clientY ?? stageBounds.top + stage.clientHeight / 2;
    const currentZoom = viewZoomRef.current;
    const currentPan = viewPanRef.current;
    const baseLeft = frameBounds.left - currentPan.x;
    const baseTop = frameBounds.top - currentPan.y;
    const videoX = (focusX - frameBounds.left) / currentZoom;
    const videoY = (focusY - frameBounds.top) / currentZoom;
    const nextPan = {
      x: focusX - baseLeft - videoX * nextZoom,
      y: focusY - baseTop - videoY * nextZoom,
    };
    viewZoomRef.current = nextZoom;
    viewPanRef.current = nextPan;
    setViewZoom(nextZoom);
    setViewPan(nextPan);
  }

  function resetVideoView() {
    viewZoomRef.current = 1;
    viewPanRef.current = { x: 0, y: 0 };
    setViewZoom(1);
    setViewPan({ x: 0, y: 0 });
  }

  useEffect(() => {
    const stage = videoStageRef.current;
    if (!stage) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0015);
      changeViewZoom(viewZoomRef.current * factor, event.clientX, event.clientY);
    }
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [videoSize.width, videoSize.height]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    let active = true;
    let previousTime = presentedFrameTimeRef.current;
    const observeFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (!active) return;
      if (metadata.mediaTime > previousTime) {
        const delta = metadata.mediaTime - previousTime;
        if (delta > 0.0001 && delta < 0.25) presentedFrameDurationRef.current = delta;
      }
      previousTime = metadata.mediaTime;
      presentedFrameTimeRef.current = metadata.mediaTime;
      videoFrameCallbackRef.current = video.requestVideoFrameCallback(observeFrame);
    };
    videoFrameCallbackRef.current = video.requestVideoFrameCallback(observeFrame);
    return () => {
      active = false;
      if (videoFrameCallbackRef.current !== null) {
        video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
        videoFrameCallbackRef.current = null;
      }
    };
  }, [playbackUrl]);

  async function captureCurrentFrame() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight || !onCaptureFrame) return;
    video.pause();
    setIsPlaying(false);
    setSaveStatus(t('Creating capture…', 'Création de la capture…'));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Capture vidéo indisponible');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('Impossible de créer la capture'))),
        'image/png',
      );
    });
    const captureTime = video.currentTime;
    const timeLabel = formatTime(captureTime, true).replace(/[:.]/g, '-');
    const captureFile = new File(
      [blob],
      safeFileName(title || file.name.replace(/\.[^.]+$/, '')) + '-capture-' + timeLabel + '.png',
      { type: 'image/png', lastModified: Date.now() },
    );
    await onCaptureFrame(captureFile, captureTime);
    setSaveStatus(t('Capture opened in an image tab', 'Capture ouverte dans un onglet image'));
  }


  async function seekAndReadPresentedFrame(target: number) {
    const video = videoRef.current;
    if (!video) return target;
    const nextTarget = Math.max(0, Math.min(duration, target));
    return new Promise<number>((resolve) => {
      let settled = false;
      let callbackId: number | null = null;
      const finish = (mediaTime: number) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        video.removeEventListener('seeked', handleSeeked);
        if (callbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
          video.cancelVideoFrameCallback(callbackId);
        }
        const exactTime = Number.isFinite(mediaTime) ? mediaTime : video.currentTime;
        presentedFrameTimeRef.current = exactTime;
        setCurrentTime(exactTime);
        resolve(exactTime);
      };
      const handleSeeked = () => {
        if (typeof video.requestVideoFrameCallback !== 'function') {
          window.requestAnimationFrame(() => finish(video.currentTime));
        }
      };
      const timeout = window.setTimeout(() => finish(video.currentTime), 800);
      video.addEventListener('seeked', handleSeeked, { once: true });
      if (typeof video.requestVideoFrameCallback === 'function') {
        callbackId = video.requestVideoFrameCallback((_now, metadata) => finish(metadata.mediaTime));
      }
      video.currentTime = nextTarget;
    });
  }

  async function stepVideoFrame(direction: -1 | 1) {
    const video = videoRef.current;
    if (!video || !duration || isSteppingFrame || isExtractingFrame) return;
    video.pause();
    setIsPlaying(false);
    setIsSteppingFrame(true);
    setSelectedFrameStopId(null);
    setSelectedId(null);
    setDraft(null);
    draftRef.current = null;
    setTool('pan');
    restoreVideoSurfaceSize();
    try {
      const currentFrameTime = Math.max(0, Math.min(duration, presentedFrameTimeRef.current || video.currentTime));
      if (direction < 0) {
        await seekAndReadPresentedFrame(Math.max(0, currentFrameTime - 0.0005));
      } else {
        let nextFrameTime = currentFrameTime;
        const probeStep = Math.max(1 / 480, Math.min(1 / 60, presentedFrameDurationRef.current / 2));
        for (let probe = 1; probe <= 40 && nextFrameTime <= currentFrameTime + 0.00001; probe += 1) {
          nextFrameTime = await seekAndReadPresentedFrame(
            Math.min(duration, currentFrameTime + probe * probeStep),
          );
          if (nextFrameTime >= duration) break;
        }
      }
      setSaveStatus((direction < 0 ? t('Previous frame', 'Image précédente') : t('Next frame', 'Image suivante')) + ' · ' + formatTime(presentedFrameTimeRef.current, true));
    } finally {
      setIsSteppingFrame(false);
    }
  }

  async function createFrameStopAtCurrentTime() {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    setIsPlaying(false);
    const frameTime = Math.max(0, Math.min(duration, presentedFrameTimeRef.current || video.currentTime));
    const duplicate = frameStops.find((stop) => Math.abs(stop.time - frameTime) < 0.0005);
    if (duplicate) {
      setSelectedFrameStopId(duplicate.id);
      setSelectedId(null);
      setTool('rect');
      setSaveStatus(t('This stop already exists · annotations enabled', 'Ce stop existe déjà · annotations activées'));
      return;
    }
    if (isPreparingPreview || isCompressing || isExtractingFrame || isSteppingFrame) return;
    if (file.size >= 2 * 1024 * 1024 * 1024) {
      window.alert(t('Local extraction accepts videos smaller than 2 GB.', 'L’extraction locale accepte des vidéos de moins de 2 Go.'));
      return;
    }
    setIsExtractingFrame(true);
    setSaveStatus(t('Extracting full-resolution PNG at ', 'Extraction PNG pleine résolution à ') + formatTime(frameTime, true) + '…');
    ffmpegOperationRef.current = 'frame';
    let ffmpeg: import('@ffmpeg/ffmpeg').FFmpeg | null = null;
    const extension = file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'video';
    const inputName = 'frame-input-' + createId() + '.' + extension;
    const outputName = 'frame-output-' + createId() + '.png';
    try {
      ffmpeg = await getFfmpeg();
      await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
      const exitCode = await ffmpeg.exec([
        '-i', inputName,
        '-ss', frameTime.toFixed(6),
        '-map', '0:v:0',
        '-frames:v', '1',
        '-compression_level', '0',
        outputName,
      ]);
      if (exitCode !== 0) throw new Error('Le moteur vidéo a terminé avec le code ' + exitCode + '.');
      const output = await ffmpeg.readFile(outputName);
      if (typeof output === 'string') throw new Error('La frame PNG générée est invalide.');
      const imageData = await bytesToDataUrl(output, 'image/png');
      const stop: VideoFrameStop = {
        id: createId(),
        time: frameTime,
        imageData,
        annotations: [],
      };
      setFrameStops((items) => [...items, stop].sort((a, b) => a.time - b.time));
      setSelectedFrameStopId(stop.id);
      setSelectedId(null);
      setTool('rect');
      setSaveStatus(t('Full-resolution stop created · draw your annotations now', 'Stop créé en pleine résolution · dessine maintenant tes annotations'));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSaveStatus(t('Frame extraction failed', 'Extraction de la frame impossible'));
      window.alert(t('Unable to extract this exact frame.\n\n', 'Impossible d’extraire cette frame exacte.\n\n') + detail);
    } finally {
      if (ffmpeg) {
        await ffmpeg.deleteFile(inputName).catch(() => undefined);
        await ffmpeg.deleteFile(outputName).catch(() => undefined);
      }
      if (ffmpegOperationRef.current === 'frame') ffmpegOperationRef.current = null;
      setIsExtractingFrame(false);
    }
  }

  function selectFrameStop(stop: VideoFrameStop) {
    videoRef.current?.pause();
    setIsPlaying(false);
    if (videoRef.current) videoRef.current.currentTime = stop.time;
    presentedFrameTimeRef.current = stop.time;
    setCurrentTime(stop.time);
    setWorkspaceMode('step');
    setSelectedFrameStopId(stop.id);
    setSelectedId(null);
    setTool('rect');
  }

  function removeFrameStop(id: string) {
    setFrameStops((items) => items.filter((stop) => stop.id !== id));
    setSelectedFrameStopId((current) => (current === id ? null : current));
    setSelectedId(null);
    setTool('pan');
    setSaveStatus(t('Frame stop deleted', 'Arrêt image supprimé'));
  }
  function annotationWindow() {
    if (workspaceMode === 'step' && selectedFrameStop) {
      return { start: selectedFrameStop.time, end: selectedFrameStop.time };
    }
    const start = Math.max(0, Math.min(currentTime, Math.max(0, duration - 0.1)));
    return { start, end: Math.max(start + 0.1, Math.min(duration || start + 3, start + 3)) };
  }

  function captureSnapshot(annotation: VideoAnnotation, index: number) {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    paintVideoAnnotation(context, annotation, index, true);
    return canvas.toDataURL('image/png');
  }

  function commitAnnotation(shape: VideoDraft) {
    const window = annotationWindow();
    const isFrameAnnotation = workspaceMode === 'step' && Boolean(selectedFrameStop);
    const annotation: VideoAnnotation = {
      id: createId(),
      type: shape.type,
      start: window.start,
      end: window.end,
      color: '#ff5c49',
      message: isFrameAnnotation
        ? t('Describe the correction to apply to this frame.', 'Décris la correction à appliquer sur cette image.')
        : t('Describe the correction to apply during this sequence.', 'Décris la correction à appliquer pendant cette séquence.'),
      x: shape.x,
      y: shape.y,
      x2: shape.x2,
      y2: shape.y2,
      points: shape.points,
    };
    if (isFrameAnnotation && selectedFrameStop) {
      setFrameStops((items) => items.map((stop) =>
        stop.id === selectedFrameStop.id
          ? { ...stop, annotations: [...(stop.annotations || []), annotation] }
          : stop
      ));
    } else {
      annotation.snapshot = captureSnapshot(annotation, annotations.length);
      setAnnotations((items) => [...items, annotation]);
    }
    setSelectedId(annotation.id);
    setTool('select');
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (![0, 1, 2].includes(event.button)) return;
    if (event.button === 2) event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    if (tool === 'pan' || event.button === 1 || event.button === 2) {
      viewPanDragRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        panX: viewPanRef.current.x,
        panY: viewPanRef.current.y,
      };
      setIsViewPanning(true);
      return;
    }

    const canAnnotate = workspaceMode === 'timeline' || (workspaceMode === 'step' && Boolean(selectedFrameStop));
    if (event.button !== 0 || !canAnnotate) return;
    videoRef.current?.pause();
    setIsPlaying(false);
    const point = canvasPoint(event);

    if (tool === 'select') {
      const hit = [...visibleAnnotations].reverse().find((annotation) => hitAnnotation(annotation, point));
      setSelectedId(hit?.id || null);
      return;
    }

    const next: VideoDraft = {
      type: tool,
      x: point.x,
      y: point.y,
      x2: point.x,
      y2: point.y,
      points: [point],
    };
    if (tool === 'note') {
      commitAnnotation(next);
      return;
    }
    draftRef.current = next;
    setDraft(next);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const panDrag = viewPanDragRef.current;
    if (panDrag) {
      const nextPan = {
        x: panDrag.panX + event.clientX - panDrag.clientX,
        y: panDrag.panY + event.clientY - panDrag.clientY,
      };
      viewPanRef.current = nextPan;
      setViewPan(nextPan);
      return;
    }

    if (!draftRef.current) return;
    const point = canvasPoint(event);
    const next = {
      ...draftRef.current,
      x2: point.x,
      y2: point.y,
      points:
        draftRef.current.type === 'draw'
          ? [...draftRef.current.points, point]
          : draftRef.current.points,
    };
    draftRef.current = next;
    setDraft(next);
  }

  function handlePointerUp() {
    if (viewPanDragRef.current) {
      viewPanDragRef.current = null;
      setIsViewPanning(false);
      return;
    }
    const value = draftRef.current;
    if (!value) return;
    draftRef.current = null;
    setDraft(null);
    const bounds = annotationBounds(value);
    if (value.type === 'draw' ? value.points.length > 1 : bounds.w + bounds.h > 8) {
      commitAnnotation(value);
    }
  }
  function handleLoadedMetadata() {
    const video = videoRef.current;
    const canvas = overlayRef.current;
    if (!video || !canvas) return;
    const nextDuration = video.duration || initialProject?.duration || 0;
    const nextStart = Math.max(0, Math.min(nextDuration, initialProject?.trimStart ?? trimStart));
    const requestedEnd = initialProject?.trimEnd ?? (trimEnd > 0 ? trimEnd : nextDuration);
    const nextEnd = Math.max(nextStart, Math.min(nextDuration, requestedEnd || nextDuration));
    setDuration(nextDuration);
    setTrimStart(Math.min(nextStart, Math.max(0, nextDuration - 0.05)));
    setTrimEnd(nextEnd > nextStart ? nextEnd : nextDuration);
    setVideoSize({ width: video.videoWidth || 16, height: video.videoHeight || 9 });
    setVideoError('');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    video.currentTime = nextStart;
    presentedFrameTimeRef.current = nextStart;
    setCurrentTime(nextStart);
    resetVideoView();
  }

  function updateTrimStart(value: number) {
    const end = effectiveTrimEnd || duration;
    const next = Math.max(0, Math.min(Number.isFinite(value) ? value : 0, Math.max(0, end - 0.05)));
    setTrimStart(next);
    setSaveStatus(t('Kept start · ', 'Début conservé · ') + formatTime(next, true));
  }

  function updateTrimEnd(value: number) {
    const next = Math.max(trimStart + 0.05, Math.min(duration, Number.isFinite(value) ? value : duration));
    setTrimEnd(next);
    setSaveStatus(t('Kept end · ', 'Fin conservée · ') + formatTime(next, true));
  }

  function handleVideoTimeUpdate(video: HTMLVideoElement) {
    const next = video.currentTime;
    if (!video.paused && effectiveTrimEnd > trimStart && next >= effectiveTrimEnd) {
      video.pause();
      video.currentTime = effectiveTrimEnd;
      setCurrentTime(effectiveTrimEnd);
      setIsPlaying(false);
      return;
    }
    setCurrentTime(next);
  }

  function seek(value: number) {
    const next = Math.max(0, duration > 0 ? Math.min(duration, value) : value);
    if (workspaceMode === 'step') {
      setSelectedFrameStopId(null);
      setSelectedId(null);
      setTool('pan');
      restoreVideoSurfaceSize();
    }
    if (videoRef.current) videoRef.current.currentTime = next;
    setCurrentTime(next);
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (workspaceMode === 'step') {
        setSelectedFrameStopId(null);
        setSelectedId(null);
        setTool('pan');
        restoreVideoSurfaceSize();
      }
      if (video.currentTime < trimStart || video.currentTime >= effectiveTrimEnd) {
        video.currentTime = trimStart;
        setCurrentTime(trimStart);
      }
      video.play().then(() => setIsPlaying(true)).catch(() => undefined);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }

  function updateSelected(patch: Partial<VideoAnnotation>) {
    if (!selectedId) return;
    if (workspaceMode === 'step' && selectedFrameStop) {
      setFrameStops((items) => items.map((stop) =>
        stop.id === selectedFrameStop.id
          ? {
              ...stop,
              annotations: (stop.annotations || []).map((annotation) =>
                annotation.id === selectedId ? ({ ...annotation, ...patch } as VideoAnnotation) : annotation
              ),
            }
          : stop
      ));
    } else {
      setAnnotations((items) =>
        items.map((annotation) =>
          annotation.id === selectedId ? ({ ...annotation, ...patch } as VideoAnnotation) : annotation,
        ),
      );
    }
  }

  function deleteSelected() {
    if (!selectedId) return;
    if (workspaceMode === 'step' && selectedFrameStop) {
      setFrameStops((items) => items.map((stop) =>
        stop.id === selectedFrameStop.id
          ? { ...stop, annotations: (stop.annotations || []).filter((annotation) => annotation.id !== selectedId) }
          : stop
      ));
    } else {
      setAnnotations((items) => items.filter((annotation) => annotation.id !== selectedId));
    }
    setSelectedId(null);
  }

  function buildPrompt() {
    const prompt = buildVideoPrompt(createVideoDeliveryProject(projectData()), locale);
    const message = workspaceInstructions.trim();
    if (!message) return prompt;
    return [
      t('# Workspace-wide message', '# Message global de l’espace de travail'),
      '', message, '',
      t(
        'This instruction applies to every image and video tab in this package.',
        'Cette consigne s’applique à tous les onglets image et vidéo de ce paquet.',
      ),
      '', prompt,
    ].join('\n');
  }
  function projectData(): VideoProjectData {
    const sourcePath = initialProject?.sourcePath || 'media/original-' + safeFileName(file.name);
    return {
      version: 1,
      kind: 'video',
      title,
      videoName: file.name,
      videoType: file.type || 'video/mp4',
      duration,
      sourcePath,
      trimmedPath: videoSelectionPath({ videoName: file.name }),
      originalSourcePath: initialProject?.originalSourcePath || sourcePath,
      originalIncluded: initialProject?.originalIncluded,
      trimStart,
      trimEnd: effectiveTrimEnd,
      generalInstructions,
      annotations,
      frameStops,
    };
  }

  async function saveProject() {
    setSaveStatus(t('Creating video project…', 'Création du projet vidéo…'));
    try {
      const baseProject = projectData();
      const bounds = videoTrimBounds(baseProject);
      const project: VideoProjectData = {
        ...baseProject,
        trimmedPath: videoSelectionPath(baseProject),
        originalSourcePath: baseProject.sourcePath,
        originalIncluded: true,
      };
      setSaveStatus(t('Encoding kept segment…', 'Encodage de la portion conservée…'));
      const trimmedVideo = await encodeTrimmedVideo(file, bounds.start, bounds.end, (progress) =>
        setSaveStatus(t('Encoding kept segment · ', 'Encodage de la portion conservée · ') + progress + '%'),
      );
      const zip = new JSZip();
      zip.file('video-project.cyannota.json', JSON.stringify(project, null, 2));
      zip.file('prompt.md', buildVideoPrompt(project, locale));
      zip.file(project.sourcePath, file, { compression: 'STORE' });
      zip.file(project.trimmedPath || videoSelectionPath(project), trimmedVideo, { compression: 'STORE' });
      annotations.forEach((annotation, index) => {
        const payload = annotation.snapshot ? dataUrlPayload(annotation.snapshot) : '';
        if (payload) {
          zip.file('captures/' + String(index + 1).padStart(2, '0') + '-annotation.png', payload, {
            base64: true,
          });
        }
      });
      const sortedStops = [...frameStops].sort((a, b) => a.time - b.time);
      for (let index = 0; index < sortedStops.length; index += 1) {
        const stop = sortedStops[index];
        const payload = dataUrlPayload(stop.imageData);
        if (payload) zip.file('frames/' + videoFrameStopFileName(stop, index), payload, { base64: true });
        const annotatedFrame = await renderAnnotatedVideoFrameStop(stop);
        if (annotatedFrame) zip.file('frames/' + videoFrameStopAnnotatedFileName(stop, index), annotatedFrame);
      }
      if (sortedStops.length) {
        zip.file(
          'frames/manifest.json',
          JSON.stringify(
            sortedStops.map((stop, index) => ({
              frame: index + 1,
              sourceFrameIndex: stop.frameIndex ?? null,
              sourceFrameNumber: stop.frameIndex === undefined ? null : stop.frameIndex + 1,
              time: stop.time,
              timecode: formatTime(stop.time, true),
              file: videoFrameStopFileName(stop, index),
              annotatedFile: stop.annotations?.length ? videoFrameStopAnnotatedFileName(stop, index) : null,
              annotations: stop.annotations || [],
            })),
            null,
            2,
          ),
        );
      }
      const archive = await zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 4 }, streamFiles: true },
        (metadata) => setSaveStatus(t('Creating ZIP · ', 'Création du ZIP · ') + Math.round(metadata.percent) + '%'),
      );
      const saved = await onSaveBlob(archive, safeFileName(title) + '.cyannota-video.zip');
      setSaveStatus(saved ? t('Video project saved', 'Projet vidéo enregistré') : t('Save cancelled', 'Enregistrement annulé'));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSaveStatus(t('Save failed', 'Échec de l’enregistrement'));
      window.alert(t('Unable to save the video project.\n\n', 'Impossible d’enregistrer le projet vidéo.\n\n') + detail);
    }
  }

  async function copyPrompt() {
    await navigator.clipboard.writeText(buildPrompt());
    setSaveStatus(t('Prompt copied', 'Prompt copié'));
  }

  async function getFfmpeg() {
    if (ffmpegRef.current) return ffmpegRef.current;
    if (ffmpegOperationRef.current === 'preview') setPreviewStatus(t('Loading local engine…', 'Chargement du moteur local…'));
    else if (ffmpegOperationRef.current === 'compression') setCompressionStatus(t('Loading local engine…', 'Chargement du moteur local…'));
    else setSaveStatus(t('Loading local video engine…', 'Chargement du moteur vidéo local…'));
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => {
      if (Number.isFinite(progress)) {
        const nextProgress = Math.max(0, Math.min(99, Math.round(progress * 100)));
        if (ffmpegOperationRef.current === 'preview') setPreviewProgress(nextProgress);
        else if (ffmpegOperationRef.current === 'compression') setCompressionProgress(nextProgress);
        else if (ffmpegOperationRef.current === 'frame') setSaveStatus(t('PNG extraction · ', 'Extraction PNG · ') + nextProgress + '%');
      }
    });
    ffmpeg.on('log', ({ message }) => {
      if (!message) return;
      if (ffmpegOperationRef.current === 'preview') setPreviewStatus(message.slice(-140));
      else if (ffmpegOperationRef.current === 'compression') setCompressionStatus(message.slice(-140));
    });
    const resources = await createLocalFfmpegResources();
    if (ffmpegWasmUrlRef.current) URL.revokeObjectURL(ffmpegWasmUrlRef.current);
    ffmpegWasmUrlRef.current = resources.wasmUrl;
    await ffmpeg.load({
      coreURL: new URL('ffmpeg-core.js', resources.baseUrl).href,
      wasmURL: resources.wasmUrl,
    });    ffmpegRef.current = ffmpeg;
    if (ffmpegOperationRef.current === 'preview') setPreviewStatus(t('Local engine loaded', 'Moteur local chargé'));
    else if (ffmpegOperationRef.current === 'compression') setCompressionStatus(t('Local engine loaded', 'Moteur local chargé'));
    else setSaveStatus(t('Local video engine loaded', 'Moteur vidéo local chargé'));
    return ffmpeg;
  }

  async function createCompatiblePreview() {
    if (isPreparingPreview || isCompressing || isExtractingFrame) return;
    if (file.size >= 2 * 1024 * 1024 * 1024) {
      window.alert(t('Local preview creation accepts videos smaller than 2 GB.', 'La création d’un aperçu local accepte des vidéos de moins de 2 Go.'));
      return;
    }
    setIsPreparingPreview(true);
    setPreviewProgress(0);
    setPreviewStatus(t('Preparing original video…', 'Préparation de la vidéo originale…'));
    previewCanceledRef.current = false;
    ffmpegOperationRef.current = 'preview';
    let ffmpeg: import('@ffmpeg/ffmpeg').FFmpeg | null = null;
    const extension = file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'video';
    const inputName = 'preview-input-' + createId() + '.' + extension;
    const outputName = 'preview-output-' + createId() + '.mp4';
    try {
      ffmpeg = await getFfmpeg();
      if (previewCanceledRef.current) return;
      setPreviewStatus(t('Reading original file…', 'Lecture du fichier original…'));
      await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
      if (previewCanceledRef.current) return;
      setPreviewStatus(t('Creating compatible H.264 preview…', 'Création de l’aperçu H.264 compatible…'));
      const exitCode = await ffmpeg.exec([
        '-i', inputName,
        '-map', '0:v:0',
        '-map', '0:a?',
        '-vf', 'scale=1920:-2:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '25',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputName,
      ]);
      if (exitCode !== 0) throw new Error('Le moteur vidéo a terminé avec le code ' + exitCode + '.');
      const output = await ffmpeg.readFile(outputName);
      if (typeof output === 'string') throw new Error('L’aperçu vidéo généré est invalide.');
      const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
      const previewBlob = new Blob([buffer], { type: 'video/mp4' });
      const nextUrl = URL.createObjectURL(previewBlob);
      if (compatiblePreviewUrlRef.current) URL.revokeObjectURL(compatiblePreviewUrlRef.current);
      compatiblePreviewUrlRef.current = nextUrl;
      setHasCompatiblePreview(true);
      setVideoError('');
      setCurrentTime(0);
      setPlaybackUrl(nextUrl);
      setPreviewProgress(100);
      setPreviewStatus(t('Compatible preview ready', 'Aperçu compatible prêt'));
      setSaveStatus(t('Compatible preview ready · original preserved', 'Aperçu compatible prêt · original conservé'));
    } catch (error) {
      if (!previewCanceledRef.current) {
        const detail = error instanceof Error ? error.message : String(error);
        setPreviewStatus(t('Unable to create compatible preview', 'Impossible de créer l’aperçu compatible'));
        window.alert(
          t('Unable to convert this video for playback.\n\n', 'Impossible de convertir cette vidéo pour la lecture.\n\n') +
          detail +
          t('\n\nThe original file was not modified.', '\n\nLe fichier original n’a pas été modifié.'),
        );
      }
    } finally {
      if (ffmpeg && !previewCanceledRef.current) {
        await ffmpeg.deleteFile(inputName).catch(() => undefined);
        await ffmpeg.deleteFile(outputName).catch(() => undefined);
      }
      if (ffmpegOperationRef.current === 'preview') ffmpegOperationRef.current = null;
      setIsPreparingPreview(false);
    }
  }

  function cancelCompatiblePreview() {
    previewCanceledRef.current = true;
    ffmpegOperationRef.current = null;
    ffmpegRef.current?.terminate();
    ffmpegRef.current = null;
    setIsPreparingPreview(false);
    setPreviewProgress(0);
    setPreviewStatus(t('Preview creation cancelled', 'Création de l’aperçu annulée'));
  }
  async function compressVideo() {
    if (isPreparingPreview || isCompressing || isExtractingFrame) return;
    if (file.size >= 2 * 1024 * 1024 * 1024) {
      window.alert(t('Web compression accepts videos smaller than 2 GB.', 'La compression web accepte des vidéos de moins de 2 Go.'));
      return;
    }
    setIsCompressing(true);
    setCompressionProgress(0);
    compressionCanceledRef.current = false;
    ffmpegOperationRef.current = 'compression';
    let ffmpeg: import('@ffmpeg/ffmpeg').FFmpeg | null = null;
    const extension = file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'video';
    const inputName = 'input-' + createId() + '.' + extension;
    const outputName = 'output-' + createId() + '.mp4';
    try {
      ffmpeg = await getFfmpeg();
      setCompressionStatus(t('Preparing video…', 'Préparation de la vidéo…'));
      await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
      const qualityArgs: Record<CompressionQuality, string[]> = {
        high: ['-preset', 'medium', '-crf', '19'],
        balanced: ['-preset', 'veryfast', '-crf', '24'],
        light: ['-preset', 'veryfast', '-crf', '30'],
      };
      setCompressionStatus(t('Local compression in progress…', 'Compression locale en cours…'));
      const exitCode = await ffmpeg.exec([
        '-i',
        inputName,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-vf',
        compressionQuality === 'light'
          ? 'scale=1280:-2:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2'
          : 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        ...qualityArgs[compressionQuality],
        '-c:a',
        'aac',
        '-b:a',
        compressionQuality === 'light' ? '96k' : '128k',
        '-movflags',
        '+faststart',
        outputName,
      ]);
      if (exitCode !== 0) throw new Error('Le moteur vidéo a terminé avec le code ' + exitCode + '.');
      const output = await ffmpeg.readFile(outputName);
      if (typeof output === 'string') throw new Error('Le fichier vidéo généré est invalide.');
      const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
      const blob = new Blob([buffer], { type: 'video/mp4' });
      setCompressionProgress(100);
      setCompressionStatus(t('Compression complete · ', 'Compression terminée · ') + (blob.size / 1024 / 1024).toFixed(1) + ' ' + t('MB', 'Mo'));
      await onSaveBlob(blob, safeFileName(title) + '-compressee.mp4');
    } catch (error) {
      if (!compressionCanceledRef.current) {
        const detail = error instanceof Error ? error.message : String(error);
        setCompressionStatus(t('Compression failed', 'Compression impossible'));
        window.alert(t('Unable to compress this video locally.\n\n', 'Impossible de compresser cette vidéo localement.\n\n') + detail);
      }
    } finally {
      if (ffmpeg && !compressionCanceledRef.current) {
        await ffmpeg.deleteFile(inputName).catch(() => undefined);
        await ffmpeg.deleteFile(outputName).catch(() => undefined);
      }
      if (ffmpegOperationRef.current === 'compression') ffmpegOperationRef.current = null;
      setIsCompressing(false);
    }
  }

  function cancelCompression() {
    compressionCanceledRef.current = true;
    ffmpegOperationRef.current = null;
    ffmpegRef.current?.terminate();
    ffmpegRef.current = null;
    setIsCompressing(false);
    setCompressionProgress(0);
    setCompressionStatus(t('Compression cancelled', 'Compression annulée'));
  }

  function beginTimelineMove(
    event: ReactPointerEvent<HTMLButtonElement>,
    annotation: VideoAnnotation,
  ) {
    if (!duration || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const timeline = event.currentTarget.closest('.video-timeline');
    if (!(timeline instanceof HTMLDivElement)) return;
    event.stopPropagation();
    timelineMoveRef.current = {
      annotationId: annotation.id,
      start: annotation.start,
      end: annotation.end,
      pointerStartX: event.clientX,
      pointerId: event.pointerId,
      timeline,
      didMove: false,
    };
    suppressTimelineClickRef.current = false;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    videoRef.current?.pause();
    setIsPlaying(false);
    setSelectedId(annotation.id);
    setMovingAnnotationId(annotation.id);
  }

  function moveTimelineAnnotation(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = timelineMoveRef.current;
    if (!active || active.pointerId !== event.pointerId || !duration) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = active.timeline.getBoundingClientRect();
    if (!bounds.width) return;
    const deltaPixels = event.clientX - active.pointerStartX;
    const wasMoving = active.didMove;
    if (Math.abs(deltaPixels) > 2) active.didMove = true;
    if (!active.didMove) return;
    if (!wasMoving) setSaveStatus(t('Moving annotation\u2026', 'D\u00e9placement de l\u2019annotation\u2026'));
    const annotationDuration = Math.max(0, active.end - active.start);
    const deltaTime = (deltaPixels / bounds.width) * duration;
    const maximumStart = Math.max(0, duration - annotationDuration);
    const nextStart = Math.max(0, Math.min(maximumStart, active.start + deltaTime));
    const nextEnd = Math.min(duration, nextStart + annotationDuration);
    setAnnotations((items) => items.map((annotation) =>
      annotation.id === active.annotationId
        ? { ...annotation, start: nextStart, end: nextEnd }
        : annotation,
    ));
    if (active.didMove) {
      if (videoRef.current) videoRef.current.currentTime = nextStart;
      setCurrentTime(nextStart);
    }
  }

  function endTimelineMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = timelineMoveRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation();
    timelineMoveRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {}
    setMovingAnnotationId(null);
    if (active.didMove) {
      suppressTimelineClickRef.current = true;
      window.setTimeout(() => {
        suppressTimelineClickRef.current = false;
      }, 0);
      setSaveStatus(t('Annotation moved on the timeline', 'Annotation d\u00e9plac\u00e9e sur la timeline'));
    }
  }

  function beginTimelineResize(
    event: ReactPointerEvent<HTMLSpanElement>,
    annotation: VideoAnnotation,
  ) {
    if (!duration) return;
    const timeline = event.currentTarget.closest('.video-timeline');
    if (!(timeline instanceof HTMLDivElement)) return;
    event.preventDefault();
    event.stopPropagation();
    timelineResizeRef.current = {
      annotationId: annotation.id,
      start: annotation.start,
      pointerId: event.pointerId,
      timeline,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    videoRef.current?.pause();
    if (videoRef.current) videoRef.current.currentTime = annotation.end;
    setIsPlaying(false);
    setCurrentTime(annotation.end);
    setSelectedId(annotation.id);
    setResizingAnnotationId(annotation.id);
    setSaveStatus(t('Drag the right edge to adjust the duration', 'Glisse le bord droit pour ajuster la dur\u00e9e'));
  }

  function moveTimelineResize(event: ReactPointerEvent<HTMLSpanElement>) {
    const active = timelineResizeRef.current;
    if (!active || active.pointerId !== event.pointerId || !duration) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = active.timeline.getBoundingClientRect();
    if (!bounds.width) return;
    const rawEnd = ((event.clientX - bounds.left) / bounds.width) * duration;
    const minimumEnd = Math.min(duration, active.start + 0.05);
    const nextEnd = Math.max(minimumEnd, Math.min(duration, rawEnd));
    setAnnotations((items) => items.map((annotation) =>
      annotation.id === active.annotationId ? { ...annotation, end: nextEnd } : annotation,
    ));
    if (videoRef.current) videoRef.current.currentTime = nextEnd;
    setCurrentTime(nextEnd);
  }

  function endTimelineResize(event: ReactPointerEvent<HTMLSpanElement>) {
    const active = timelineResizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    timelineResizeRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {}
    setResizingAnnotationId(null);
    setSaveStatus(t('Annotation duration updated', 'Dur\u00e9e de l\u2019annotation mise \u00e0 jour'));
  }

  function timelineSeek(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - rect.left) / rect.width) * duration);
  }

  return (
    <main className="video-shell">
      <header className="video-topbar">
        <div className="video-brand">
          {onClose && <button className="video-back" onClick={onClose} aria-label={t('Back to images', 'Revenir aux images')}>←</button>}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-mark" src="/cyannota-logo.png" alt="" />
          <div>
            <strong>{t('CyAnnota Video', 'CyAnnota Vidéo')}</strong>
            <span className="brand-subtitle">{t('Local timed annotations', 'Annotations temporelles locales')}</span>
            <VersionStatus locale={locale} />
          </div>
        </div>
        <label className="project-title video-title">
          <span className="status-dot" />
          <input aria-label={t('Video project name', 'Nom du projet vidéo')} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <div className="top-actions">
          <label className="language-picker" title={t('Interface and prompt language', 'Langue de l’interface et des prompts')}>
            <span>{locale.toUpperCase()}</span>
            <select value={locale} onChange={(event) => requestLocaleChange(event.target.value as AppLocale)} aria-label={t('Language', 'Langue')}>
              <option value="en">English</option>
              <option value="fr">Français</option>
            </select>
          </label>
          <span className="video-local-badge">● 100% local</span>
          {onEditWorkspaceMessage && (
            <button
              className={'button ghost compact workspace-message-button' + (workspaceInstructions.trim() ? ' active' : '')}
              onClick={onEditWorkspaceMessage}
            >{t('Global message', 'Message global')}</button>
          )}
          {onOpenWorkspace && <button className="button ghost compact" onClick={onOpenWorkspace}>{t('Open', 'Ouvrir')}</button>}
          {onAddImage && <button className="button ghost compact" onClick={onAddImage}>{t('Image', 'Image')}</button>}
          {onAddVideo && <button className="button ghost compact" onClick={onAddVideo}>{t('Video', 'Vidéo')}</button>}
          <button className="button ghost compact" onClick={() => copyPrompt().catch(() => undefined)}>Prompt</button>
          <button className="button ghost compact" onClick={() => setCompressionOpen(true)} disabled={isPreparingPreview || isExtractingFrame}>{t('Compress', 'Compresser')}</button>
          <button className="button ghost compact" onClick={onSaveWorkspace || (() => saveProject().catch(() => undefined))} disabled={workspaceBusy}>{workspaceBusy ? t('Encoding…', 'Encodage…') : t('Save', 'Sauver')}</button>
          {onExportWorkspace && <button className="button primary" onClick={onExportWorkspace} disabled={workspaceBusy}>{t('Export', 'Exporter')}</button>}
        </div>
      </header>

      {tabBar}
      <div className="video-modebar">
        <div className="video-mode-switch" aria-label={t('Video editing mode', 'Mode d’édition vidéo')}>
          <button className={workspaceMode === 'timeline' ? 'active' : ''} onClick={() => { setSelectedFrameStopId(null); setSelectedId(null); restoreVideoSurfaceSize(); setWorkspaceMode('timeline'); setTool('select'); }}>{t('Full timeline', 'Timeline complète')}</button>
          <button className={workspaceMode === 'capture' ? 'active' : ''} onClick={() => { setSelectedFrameStopId(null); setSelectedId(null); restoreVideoSurfaceSize(); setWorkspaceMode('capture'); setTool('pan'); }}>{t('Capture → tab', 'Capture → onglet')}</button>
          <button className={workspaceMode === 'step' ? 'active' : ''} onClick={() => { videoRef.current?.pause(); setIsPlaying(false); setSelectedFrameStopId(null); setSelectedId(null); setWorkspaceMode('step'); setTool('pan'); }}>{t('Step frame → export', 'Step frame → export')}</button>
        </div>
        <span>
          {workspaceMode === 'timeline'
            ? t('Timed annotations · wheel: zoom · right click: move', 'Annotations temporelles · molette : zoom · clic droit : déplacer')
            : workspaceMode === 'capture'
              ? t('Immediately create an editable image tab from the displayed frame', 'Crée immédiatement un onglet image éditable depuis la frame affichée')
              : t('Pause the video · move one frame forward or back · create an annotatable stop', 'Arrête la vidéo · avance ou recule d’une image · crée un stop annotable')}
        </span>
        {workspaceMode === 'capture' && (
          <button className="button primary compact" onClick={() => captureCurrentFrame().catch((error) => window.alert(error instanceof Error ? error.message : String(error)))} disabled={!duration || Boolean(videoError)}>
            {t('Capture at ', 'Capturer à ')}{formatTime(currentTime, true)}
          </button>
        )}
        {workspaceMode === 'step' && <span className="video-step-hint">{t('Frame-by-frame controls appear over the video when it is paused.', 'Les commandes image par image apparaissent sur la vidéo lorsqu’elle est en pause.')}</span>}
        <div className="video-view-zoom">
          <button onClick={() => changeViewZoom(viewZoomRef.current - 0.1)} aria-label={t('Zoom video out', 'Réduire le zoom vidéo')}>−</button>
          <strong>{Math.round(viewZoom * 100)}%</strong>
          <button onClick={() => changeViewZoom(viewZoomRef.current + 0.1)} aria-label={t('Zoom video in', 'Augmenter le zoom vidéo')}>+</button>
          <button onClick={resetVideoView}>{t('Fit', 'Ajuster')}</button>
        </div>
      </div>

      <section className={'video-layout ' + (tabBar ? 'has-media-tabs' : '')}>
        <aside className="toolrail video-toolrail" aria-label={t('Video tools', 'Outils vidéo')}>
          {(Object.keys(VIDEO_TOOL_ICONS) as VideoTool[]).map((item) => (
            <button
              key={item}
              className={'tool ' + (tool === item ? 'active' : '')}
              data-label={VIDEO_TOOL_LABELS[locale][item]}
              aria-label={VIDEO_TOOL_LABELS[locale][item]}
              onClick={() => setTool(item)}
              disabled={workspaceMode === 'capture'
                ? item !== 'pan'
                : workspaceMode === 'step' && !selectedFrameStop
                  ? item !== 'pan'
                  : false}
            >
              {VIDEO_TOOL_ICONS[item]}
            </button>
          ))}
          <span className="tool-spacer" />
          <button className="tool danger" data-label={t('Delete', 'Supprimer')} onClick={deleteSelected} disabled={!selected}>×</button>
        </aside>

        <section className={'video-center ' + (workspaceMode !== 'timeline' ? 'capture-mode' : '')}>
          <div ref={videoStageRef} className="video-stage">
            <div
              ref={videoFrameRef}
              className="video-frame"
              style={{
                aspectRatio: videoSize.width + ' / ' + videoSize.height,
                transform: 'translate3d(' + viewPan.x + 'px, ' + viewPan.y + 'px, 0) scale(' + viewZoom + ')',
              }}
            >
              <video
                ref={videoRef}
                src={playbackUrl}
                preload="metadata"
                onLoadedMetadata={handleLoadedMetadata}
                onError={() => setVideoError(
                  hasCompatiblePreview
                    ? t('The converted preview remains unreadable.', 'L’aperçu converti reste illisible.')
                    : isGifSource
                      ? t('The animated GIF preview could not be prepared.', 'L’aperçu du GIF animé n’a pas pu être préparé.')
                      : t('This video format cannot be played directly.', 'Ce format vidéo ne peut pas être lu directement.'),
                )}
                onTimeUpdate={(event) => handleVideoTimeUpdate(event.currentTarget)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
              />
              {workspaceMode === 'step' && selectedFrameStop && (
                <img
                  className="video-step-preview"
                  src={selectedFrameStop.imageData}
                  alt={t('Stop at ', 'Stop à ') + formatTime(selectedFrameStop.time, true)}
                  draggable={false}
                  onLoad={(event) => {
                    const width = event.currentTarget.naturalWidth || 16;
                    const height = event.currentTarget.naturalHeight || 9;
                    setVideoSize({ width, height });
                    if (overlayRef.current) {
                      overlayRef.current.width = width;
                      overlayRef.current.height = height;
                      const context = overlayRef.current.getContext('2d');
                      selectedFrameStop.annotations?.forEach((annotation, index) => {
                        if (context) paintVideoAnnotation(context, annotation, index, annotation.id === selectedId);
                      });
                    }
                  }}
                />
              )}
              <canvas
                ref={overlayRef}
                className={'video-overlay video-cursor-' + (isViewPanning ? 'panning' : tool)}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onContextMenu={(event) => event.preventDefault()}
              />
              {workspaceMode === 'step' && !isPlaying && (
                <div className="video-direct-step-controls">
                  <button onClick={() => stepVideoFrame(-1).catch(() => undefined)} disabled={isSteppingFrame || isExtractingFrame || !duration}>−1 {t('frame', 'image')}</button>
                  <button className="create-stop" onClick={() => createFrameStopAtCurrentTime().catch(() => undefined)} disabled={isSteppingFrame || isExtractingFrame || !duration}>
                    {isExtractingFrame ? t('Extracting PNG…', 'Extraction PNG…') : selectedFrameStop ? t('Active stop · annotate here', 'Stop actif · annoter ici') : t('Create a stop here', 'Créer un stop ici')}
                  </button>
                  <button onClick={() => stepVideoFrame(1).catch(() => undefined)} disabled={isSteppingFrame || isExtractingFrame || !duration}>+1 {t('frame', 'image')}</button>
                </div>
              )}
            </div>
            {videoError && !(workspaceMode === 'step' && selectedFrameStop) ? (
              <div className="video-loading video-load-error" role="alert">
                <strong>{videoError}</strong>
                {isPreparingPreview ? (
                  <>
                    <span>{previewStatus}</span>
                    <div className="video-preview-progress"><progress max="100" value={previewProgress} /><b>{previewProgress}%</b></div>
                    <button className="button ghost compact" onClick={cancelCompatiblePreview}>{t('Cancel', 'Annuler')}</button>
                  </>
                ) : !hasCompatiblePreview ? (
                  <>
                    <span>{t('CyAnnota can create a local H.264 playback copy. The original video or GIF remains untouched in the project.', 'CyAnnota peut créer localement une copie de lecture H.264. La vidéo ou le GIF d’origine reste intact dans le projet.')}</span>
                    <button className="button primary compact" onClick={() => createCompatiblePreview().catch(() => undefined)}>{t('Create compatible preview', 'Créer un aperçu compatible')}</button>
                  </>
                ) : (
                  <span>{t('Conversion succeeded, but Chromium still cannot display the video.', 'La conversion a réussi, mais Chromium ne parvient toujours pas à afficher la vidéo.')}</span>
                )}
              </div>
            ) : (
              !duration && !(workspaceMode === 'step' && selectedFrameStop) && <div className="video-loading">{t('Preparing video…', 'Préparation de la vidéo…')}</div>
            )}
          </div>

          <div className="video-transport">
            <button onClick={() => seek(currentTime - 1)} aria-label={t('Back one second', 'Reculer d’une seconde')}>−1s</button>
            <button className="video-play" onClick={togglePlayback} aria-label={isPlaying ? t('Pause', 'Pause') : t('Play', 'Lire')}>{isPlaying ? 'Ⅱ' : '▶'}</button>
            <button onClick={() => seek(currentTime + 1)} aria-label={t('Forward one second', 'Avancer d’une seconde')}>+1s</button>
            <strong>{formatTime(currentTime, true)}</strong>
            <span>/ {formatTime(duration, true)}</span>
            <input
              aria-label={t('Playback position', 'Position de lecture')}
              type="range"
              min="0"
              max={Math.max(duration, 0.01)}
              step="0.01"
              value={Math.min(currentTime, duration || 0)}
              onChange={(event) => seek(Number(event.target.value))}
            />
          </div>

          {workspaceMode === 'timeline' && <div className="video-timeline-panel">
            <div className="video-timeline-heading">
              <div><span>TIMELINE</span><strong>{annotations.length} {annotations.length === 1 ? t('correction', 'correction') : t('corrections', 'corrections')} · {frameStops.length} {frameStops.length === 1 ? t('frame stop', 'arrêt image') : t('frame stops', 'arrêts image')} · {formatTime(keptDuration, true)} {t('kept', 'conservées')}</strong></div>
              <label>Zoom <input type="range" min="1" max="5" step="0.25" value={timelineZoom} onChange={(event) => setTimelineZoom(Number(event.target.value))} /></label>
            </div>
            <div className="video-timeline-scroll">
              <div className="video-timeline" style={{ width: timelineZoom * 100 + '%' }} onPointerDown={timelineSeek}>
                <div className="video-time-ruler">
                  {Array.from({ length: 11 }, (_, index) => (
                    <span key={index} style={{ left: index * 10 + '%' }}>{formatTime((duration * index) / 10)}</span>
                  ))}
                </div>
                <div className="video-tracks">
                  <div className="video-trim-excluded video-trim-excluded-start" style={{ width: duration ? (trimStart / duration) * 100 + '%' : '0%' }} />
                  <div className="video-trim-kept" style={{ left: duration ? (trimStart / duration) * 100 + '%' : '0%', width: duration ? ((effectiveTrimEnd - trimStart) / duration) * 100 + '%' : '100%' }} />
                  <div className="video-trim-excluded video-trim-excluded-end" style={{ left: duration ? (effectiveTrimEnd / duration) * 100 + '%' : '100%' }} />
                  <i className="video-trim-marker start" style={{ left: duration ? (trimStart / duration) * 100 + '%' : '0%' }} data-label={t('START', 'DÉBUT')} />
                  <i className="video-trim-marker end" style={{ left: duration ? (effectiveTrimEnd / duration) * 100 + '%' : '100%' }} data-label={t('END', 'FIN')} />
                  {annotations.map((annotation, index) => (
                    <button
                      key={annotation.id}
                      className={'video-clip' + (annotation.id === selectedId ? ' selected' : '') + (annotation.id === resizingAnnotationId ? ' resizing' : '') + (annotation.id === movingAnnotationId ? ' moving' : '')}
                      style={{
                        left: duration ? (annotation.start / duration) * 100 + '%' : '0%',
                        width: duration ? Math.max(0.6, ((annotation.end - annotation.start) / duration) * 100) + '%' : '1%',
                        top: (index % 3) * 25 + 3,
                        background: annotation.color,
                      }}
                      onPointerDown={(event) => beginTimelineMove(event, annotation)}
                      onPointerMove={moveTimelineAnnotation}
                      onPointerUp={endTimelineMove}
                      onPointerCancel={endTimelineMove}
                      onLostPointerCapture={endTimelineMove}
                      onClick={(event) => {
                        if (suppressTimelineClickRef.current) {
                          event.preventDefault();
                          event.stopPropagation();
                          suppressTimelineClickRef.current = false;
                          return;
                        }
                        setSelectedId(annotation.id);
                        seek(annotation.start);
                      }}
                      title={formatTime(annotation.start, true) + ' \u2192 ' + formatTime(annotation.end, true) + ' \u00b7 ' + t('Drag to move \u00b7 right edge to change duration', 'Glisse pour d\u00e9placer \u00b7 bord droit pour changer la dur\u00e9e')}
                    >
                      {String(index + 1).padStart(2, '0')}
                      <span
                        className="video-clip-resize-handle"
                        aria-hidden="true"
                        title={t('Drag to change annotation duration', 'Glisser pour changer la dur\u00e9e de l\u2019annotation')}
                        onPointerDown={(event) => beginTimelineResize(event, annotation)}
                        onPointerMove={moveTimelineResize}
                        onPointerUp={endTimelineResize}
                        onPointerCancel={endTimelineResize}
                        onLostPointerCapture={endTimelineResize}
                        onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                      />
                    </button>
                  ))}
                  {frameStops.map((stop, index) => (
                    <button
                      key={stop.id}
                      className={'video-frame-stop ' + (stop.id === selectedFrameStopId ? 'selected' : '')}
                      data-label={'F' + String(index + 1).padStart(2, '0')}
                      style={{ left: duration ? (stop.time / duration) * 100 + '%' : '0%' }}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => selectFrameStop(stop)}
                      title={'Frame ' + String(index + 1).padStart(2, '0') + ' — ' + formatTime(stop.time, true)}
                      aria-label={t('Go to frame ', 'Aller à la frame ') + String(index + 1).padStart(2, '0') + t(' at ', ' à ') + formatTime(stop.time, true)}
                    />
                  ))}
                  <i className="video-playhead" style={{ left: duration ? (currentTime / duration) * 100 + '%' : '0%' }} />
                </div>
              </div>
            </div>
          </div>}
        </section>

        <aside className="video-inspector">
          <section className="video-trim-panel">
            <div className="video-trim-heading">
              <div><p className="eyebrow">{t('VIDEO TRIM', 'DÉCOUPE VIDÉO')}</p><strong>{formatTime(keptDuration, true)} {t('kept', 'conservées')}</strong></div>
              <button className="button ghost compact" onClick={() => { setTrimStart(0); setTrimEnd(duration); setSaveStatus(t('Full video kept', 'Vidéo complète conservée')); }} disabled={!duration}>{t('Keep all', 'Tout garder')}</button>
            </div>
            <div className="video-trim-fields">
              <label>
                <span>{t('Start', 'Début')}</span>
                <div><input type="number" min="0" max={Math.max(0, effectiveTrimEnd - 0.05)} step="0.01" value={trimStart.toFixed(2)} onChange={(event) => updateTrimStart(Number(event.target.value))} /><button onClick={() => updateTrimStart(currentTime)}>{t('Current position', 'Position actuelle')}</button></div>
                <input type="range" min="0" max={Math.max(duration, 0.05)} step="0.01" value={trimStart} onChange={(event) => updateTrimStart(Number(event.target.value))} />
              </label>
              <label>
                <span>{t('End', 'Fin')}</span>
                <div><input type="number" min={trimStart + 0.05} max={duration} step="0.01" value={effectiveTrimEnd.toFixed(2)} onChange={(event) => updateTrimEnd(Number(event.target.value))} /><button onClick={() => updateTrimEnd(currentTime)}>{t('Current position', 'Position actuelle')}</button></div>
                <input type="range" min="0" max={Math.max(duration, 0.05)} step="0.01" value={effectiveTrimEnd} onChange={(event) => updateTrimEnd(Number(event.target.value))} />
              </label>
            </div>
            <div className="video-trim-summary"><span>{formatTime(trimStart, true)}</span><i>→</i><span>{formatTime(effectiveTrimEnd, true)}</span><b>{duration > 0 ? Math.round((keptDuration / duration) * 100) : 0}% {t('of source', 'de la source')}</b></div>
            <small>{t('The kept segment will be encoded for Save and Export. Save also retains the original source.', 'La portion conservée sera encodée pour Save et Export. Save garde aussi la source originale.')}</small>
          </section>
          {workspaceMode === 'capture' && (
            <section className="video-capture-panel">
              <p className="eyebrow">{t('CAPTURE AT AN INSTANT', 'CAPTURE À UN INSTANT')}</p>
              <strong>{formatTime(currentTime, true)}</strong>
              <span>{t('The frame will open as a new image tab with every cutout, shape, eyedropper, and annotation tool.', 'La frame sera ouverte comme un nouvel onglet image avec tous les outils de découpe, formes, pipette et annotations.')}</span>
              <button className="button primary" onClick={() => captureCurrentFrame().catch((error) => window.alert(error instanceof Error ? error.message : String(error)))} disabled={!duration || Boolean(videoError)}>{t('Create image tab', 'Créer l’onglet image')}</button>
            </section>
          )}
          {workspaceMode === 'step' && (
            <section className="video-frame-stops-panel">
              <div className="video-frame-stops-heading">
                <div><p className="eyebrow">{t('ANNOTATABLE STOPS', 'STOPS ANNOTABLES')}</p><strong>{frameStops.length} {frameStops.length === 1 ? t('stop created', 'stop créé') : t('stops created', 'stops créés')}</strong></div>
              </div>
              <span>{t('Browse the video directly. When the wanted frame is displayed, create a stop: only that frame will be extracted as a full-resolution PNG.', 'Parcours directement la vidéo. Quand l’image voulue est affichée, crée un stop : seule cette image sera extraite en PNG pleine résolution.')}</span>
              <div className="video-current-stop-summary">
                <div><small>{t('DISPLAYED FRAME', 'IMAGE AFFICHÉE')}</small><strong>{formatTime(currentTime, true)}</strong></div>
                <button className="button primary compact" onClick={() => createFrameStopAtCurrentTime().catch(() => undefined)} disabled={isExtractingFrame || isSteppingFrame || !duration}>
                  {isExtractingFrame ? t('Extracting PNG…', 'Extraction PNG…') : selectedFrameStop ? t('Active stop', 'Stop actif') : t('Create a stop here', 'Créer un stop ici')}
                </button>
              </div>
              <div className="video-frame-stop-list">
                {frameStops.map((stop, index) => (
                  <div key={stop.id} className={'video-frame-stop-row ' + (stop.id === selectedFrameStopId ? 'selected' : '')}>
                    <button onClick={() => selectFrameStop(stop)}>
                      <span>{'F' + String(index + 1).padStart(2, '0')}</span>
                      <strong>{formatTime(stop.time, true)}</strong>
                      <small>{(stop.annotations || []).length} annotation{(stop.annotations || []).length === 1 ? '' : 's'}</small>
                    </button>
                    <button className="video-frame-stop-delete" onClick={() => removeFrameStop(stop.id)} aria-label={t('Delete stop ', 'Supprimer le stop ') + String(index + 1).padStart(2, '0')}>×</button>
                  </div>
                ))}
                {!frameStops.length && <p className="video-empty">{t('No stops. Pause the video, then use “Create a stop here”.', 'Aucun stop. Mets la vidéo en pause puis utilise “Créer un stop ici”.')}</p>}
              </div>
            </section>
          )}
          <section className="video-general">
            <p className="eyebrow">{t('VIDEO MESSAGE', 'MESSAGE DE LA VIDÉO')}</p>
            <textarea value={generalInstructions} onChange={(event) => setGeneralInstructions(event.target.value)} placeholder={t('General context for every correction…', 'Contexte général pour toutes les corrections…')} />
          </section>
          <section className="video-corrections">
            <div className="video-corrections-heading"><div><p className="eyebrow">{t('ANNOTATIONS', 'ANNOTATIONS')}</p><h2>{workspaceMode === 'step' ? t('Stop corrections', 'Corrections du stop') : t('Corrections', 'Corrections')} <span>{activeAnnotations.length}</span></h2></div></div>
            <div className="video-correction-list">
              {activeAnnotations.map((annotation, index) => (
                <button
                  key={annotation.id}
                  className={'video-correction-card ' + (annotation.id === selectedId ? 'selected' : '')}
                  onClick={() => { setSelectedId(annotation.id); if (workspaceMode === 'timeline') seek(annotation.start); }}
                >
                  <span style={{ background: annotation.color }}>{String(index + 1).padStart(2, '0')}</span>
                  <div><strong>{VIDEO_TOOL_LABELS[locale][annotation.type]}</strong><small>{workspaceMode === 'step' ? t('Still image · ', 'Image fixe · ') + formatTime(annotation.start, true) : formatTime(annotation.start, true) + ' → ' + formatTime(annotation.end, true)}</small><em>{annotation.message}</em></div>
                </button>
              ))}
              {!activeAnnotations.length && <p className="video-empty">{workspaceMode === 'step' ? selectedFrameStop ? t('Choose a tool, then draw on this stop. These annotations will remain linked only to this frame.', 'Choisis un outil puis dessine sur ce stop. Ces annotations resteront liées uniquement à cette image.') : t('Create or select a stop to display its annotations.', 'Crée ou sélectionne un stop pour afficher ses annotations.') : workspaceMode === 'capture' ? t('Capture mode does not mix timeline annotations.', 'Le mode Capture ne mélange pas les annotations de la timeline.') : t('Choose a tool, then draw directly on the video. The correction will be added to the timeline.', 'Choisis un outil puis dessine directement sur la vidéo. La correction sera ajoutée à la timeline.')}</p>}
            </div>
          </section>

          {selected && (
            <section className="video-editor">
              <div className="video-editor-heading"><div><p className="eyebrow">CORRECTION</p><h3>{VIDEO_TOOL_LABELS[locale][selected.type]}</h3></div><button onClick={() => setSelectedId(null)}>×</button></div>
              {workspaceMode === 'timeline' && (
                <div className="video-time-fields">
                  <label><span>{t('Start', 'Début')}</span><input type="number" min="0" max={selected.end} step="0.01" value={selected.start.toFixed(2)} onChange={(event) => updateSelected({ start: Math.max(0, Math.min(Number(event.target.value), selected.end - 0.01)) })} /></label>
                  <label><span>{t('End', 'Fin')}</span><input type="number" min={selected.start} max={duration} step="0.01" value={selected.end.toFixed(2)} onChange={(event) => updateSelected({ end: Math.max(selected.start + 0.01, Math.min(duration, Number(event.target.value))) })} /></label>
                </div>
              )}
              <label className="video-color-field"><span>{t('Color', 'Couleur')}</span><input type="color" value={selected.color} onChange={(event) => updateSelected({ color: event.target.value })} /></label>
              <label className="message-field"><span>{workspaceMode === 'step' ? t('Message linked to this frame', 'Message lié à cette image') : t('Message linked to this sequence', 'Message lié à cette séquence')}</span><textarea value={selected.message} onChange={(event) => updateSelected({ message: event.target.value })} /></label>
              {selected.snapshot && <img className="video-snapshot" src={selected.snapshot} alt={t('Correction capture', 'Capture de la correction')} />}
              <button className="delete-button" onClick={deleteSelected}>{t('Delete this correction', 'Supprimer cette correction')}</button>
            </section>
          )}
          <footer className="video-status">
            <span>{workspaceStatus || saveStatus}</span>
            <a href="https://github.com/MrMybal/CyAnnota" target="_blank" rel="noreferrer">Source · AGPL-3.0</a>
          </footer>
        </aside>
      </section>

      {compressionOpen && (
        <div className="modal-backdrop">
          <section className="video-compression-modal">
            <header className="modal-header">
              <div><p className="eyebrow">{t('LOCAL COMPRESSION', 'COMPRESSION LOCALE')}</p><h2>{t('Reduce video size', 'Réduire la vidéo')}</h2><p>{t('All processing remains in this browser. The original video is never modified.', 'Tout le traitement reste dans ce navigateur. La vidéo originale n’est jamais modifiée.')}</p></div>
              <button className="modal-close" onClick={() => !isCompressing && setCompressionOpen(false)} disabled={isCompressing}>×</button>
            </header>
            <div className="video-source-summary"><div><span>{t('Source', 'Source')}</span><strong>{file.name}</strong></div><div><span>{t('Size', 'Taille')}</span><strong>{(file.size / 1024 / 1024).toFixed(1)} {t('MB', 'Mo')}</strong></div><div><span>{t('Duration', 'Durée')}</span><strong>{formatTime(duration)}</strong></div></div>
            <div className="video-quality-options">
              {([
                ['high', t('High quality', 'Haute qualité'), t('Image very close to the original, with a larger file.', 'Image très proche de l’original, fichier plus lourd.')],
                ['balanced', t('Balanced', 'Équilibré'), t('Good compromise for sharing an interface capture.', 'Bon compromis pour partager une capture d’interface.')],
                ['light', t('Lightweight file', 'Fichier léger'), t('Also reduces resolution to a maximum of 1280 px.', 'Réduit aussi la définition à 1280 px maximum.')],
              ] as const).map(([value, label, help]) => (
                <label key={value} className={compressionQuality === value ? 'selected' : ''}><input type="radio" name="video-quality" value={value} checked={compressionQuality === value} onChange={() => setCompressionQuality(value)} disabled={isCompressing} /><div><strong>{label}</strong><span>{help}</span></div></label>
              ))}
            </div>
            <div className="video-compression-progress"><div><span>{compressionStatus}</span><strong>{compressionProgress}%</strong></div><progress max="100" value={compressionProgress} /></div>
            <footer className="modal-actions">
              {isCompressing ? <button className="button ghost" onClick={cancelCompression}>{t('Cancel compression', 'Annuler la compression')}</button> : <button className="button ghost" onClick={() => setCompressionOpen(false)}>{t('Close', 'Fermer')}</button>}
              <button className="button primary large" onClick={() => compressVideo().catch(() => undefined)} disabled={isCompressing}>{isCompressing ? t('Compressing…', 'Compression en cours…') : t('Compress and save', 'Compresser et enregistrer')}</button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
