'use client';

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ChangeEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { translate, type AppLocale } from './i18n';
import VersionStatus from './version-status';

export type ModelAction = 'camera' | 'modify' | 'delete' | 'recolor' | 'separate';
export type ModelPoint = [number, number, number];

export type ModelCamera = {
  referenceMesh: string;
  position: ModelPoint;
  target: ModelPoint;
  up: ModelPoint;
  fov: number;
};

export type ModelPaintPoint = {
  position: ModelPoint;
  normal: ModelPoint;
  meshName: string;
  faceIndex?: number;
};

export type ModelAnnotation = {
  id: string;
  action: ModelAction;
  color: string;
  targetColor: string;
  description: string;
  radius: number;
  points: ModelPaintPoint[];
  camera: ModelCamera;
  views?: ModelCamera[];
  createdAt: number;
};

type ModelDisplayMode = 'textured' | 'solid' | 'wireframe';

export type ModelViewpoint = {
  id: string;
  name: string;
  camera: ModelCamera;
  snapshot: string;
  createdAt: number;
};

export type ModelProjectData = {
  version: 1;
  kind: 'model';
  title: string;
  modelName: string;
  modelType: string;
  sourcePath: string;
  convertedPath: string;
  generalInstructions: string;
  annotations: ModelAnnotation[];
  viewpoints: ModelViewpoint[];
};

export type ConvertedModel = {
  source: File;
  glb: File;
  project: ModelProjectData;
};

type LoadedModel = {
  object: THREE.Object3D;
  dispose: () => void;
};

type ViewerRuntime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  modelRoot: THREE.Group;
  paintRoot: THREE.Group;
  raycaster: THREE.Raycaster;
  frame: number;
};

const MODEL_EXTENSIONS = new Set(['glb', 'gltf', 'fbx', 'obj', 'usd', 'usda', 'usdc', 'usdz', 'blend']);
const MODEL_ACTION_COLORS: Record<Exclude<ModelAction, 'camera'>, string> = {
  modify: '#ffb84d',
  delete: '#ff4d5e',
  recolor: '#55d68a',
  separate: '#a978ff',
};

function extensionOf(name: string) {
  return name.split('.').pop()?.toLowerCase() || '';
}

export function isModelFile(file: File) {
  return MODEL_EXTENSIONS.has(extensionOf(file.name));
}

function safeFileName(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^[.-]+|[.-]+$/g, '') || 'model';
}

function createId() {
  return crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function currentTimestamp() {
  return Date.now();
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    });
  });
}

function resourceMap(files: File[]) {
  const urls = new Map<string, string>();
  files.forEach((file) => {
    const url = URL.createObjectURL(file);
    urls.set(file.name, url);
    urls.set(file.webkitRelativePath || file.name, url);
    urls.set(file.name.split('/').pop() || file.name, url);
  });
  return {
    resolve(url: string) {
      const normalized = decodeURIComponent(url).replace(/^\.\//, '');
      return urls.get(normalized) || urls.get(normalized.split('/').pop() || normalized) || url;
    },
    dispose() { urls.forEach((url) => URL.revokeObjectURL(url)); },
  };
}

function parseGltfBuffer(loader: GLTFLoader, buffer: ArrayBuffer, path = '') {
  return new Promise<Awaited<ReturnType<GLTFLoader['parseAsync']>>>((resolve, reject) => {
    const parse = () => loader.parse(buffer, path, resolve, reject);
    const useDesktopImageFallback =
      typeof window !== 'undefined' &&
      Boolean(window.cyAnnotaDesktop) &&
      typeof globalThis.createImageBitmap !== 'undefined';

    if (!useDesktopImageFallback) {
      try { parse(); } catch (error) { reject(error); }
      return;
    }

    // Electron's file:// renderer cannot reliably fetch GLB or texture blob URLs.
    // Hiding createImageBitmap while GLTFLoader builds its parser selects TextureLoader instead.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
    try {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        writable: true,
        value: undefined,
      });
      parse();
    } catch (error) {
      reject(error);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'createImageBitmap', descriptor);
      else Reflect.deleteProperty(globalThis, 'createImageBitmap');
    }
  });
}

async function parseModel(files: File[]): Promise<LoadedModel> {
  const source = files.find(isModelFile);
  if (!source) throw new Error('No supported 3D model was selected.');
  const extension = extensionOf(source.name);
  const buffer = await source.arrayBuffer();
  const resources = resourceMap(files);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => resources.resolve(url));

  try {
    if (extension === 'glb' || extension === 'gltf') {
      const loader = new GLTFLoader(manager);
      const gltf = await parseGltfBuffer(loader, buffer);
      return { object: gltf.scene, dispose: resources.dispose };
    }
    if (extension === 'fbx') {
      return { object: new FBXLoader(manager).parse(buffer, ''), dispose: resources.dispose };
    }
    if (extension === 'obj') {
      return { object: new OBJLoader(manager).parse(new TextDecoder().decode(buffer)), dispose: resources.dispose };
    }
    if (['usd', 'usda', 'usdc', 'usdz'].includes(extension)) {
      return { object: new USDLoader(manager).parse(buffer, ''), dispose: resources.dispose };
    }
    throw new Error('Raw .' + extension + ' files are not supported by the local web converter. Export USDZ or GLB instead.');
  } catch (error) {
    resources.dispose();
    throw error;
  }
}

function exportBinaryGlb(object: THREE.Object3D) {
  const exporter = new GLTFExporter();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      object,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error('The local converter returned JSON instead of a binary GLB.'));
      },
      reject,
      { binary: true, onlyVisible: false, truncateDrawRange: false },
    );
  });
}

export async function convertModelFiles(files: File[], locale: AppLocale): Promise<ConvertedModel> {
  const source = files.find(isModelFile);
  if (!source) throw new Error(translate(locale, 'Choose a GLB, glTF, FBX, OBJ, or USDZ file.', 'Choisis un fichier GLB, glTF, FBX, OBJ ou USDZ.'));
  if (extensionOf(source.name) === 'blend') {
    throw new Error(translate(locale, 'A .blend file requires Blender itself and cannot be converted safely inside the browser. Export it as GLB from Blender.', 'Un fichier .blend nécessite Blender lui-même et ne peut pas être converti proprement dans le navigateur. Exporte-le en GLB depuis Blender.'));
  }

  let glb: File;
  if (extensionOf(source.name) === 'glb' && files.length === 1) {
    glb = new File([source], source.name, { type: 'model/gltf-binary', lastModified: source.lastModified });
  } else {
    const loaded = await parseModel(files);
    try {
      const binary = await exportBinaryGlb(loaded.object);
      glb = new File([binary], safeFileName(source.name.replace(/\.[^.]+$/, '')) + '.glb', {
        type: 'model/gltf-binary',
        lastModified: Date.now(),
      });
    } finally {
      disposeObject(loaded.object);
      loaded.dispose();
    }
  }

  const title = source.name.replace(/\.[^.]+$/, '') || translate(locale, '3D model', 'Modèle 3D');
  const convertedPath = 'model/converted-' + safeFileName(glb.name);
  const sourcePath = extensionOf(source.name) === 'glb'
    ? convertedPath
    : 'model/source-' + safeFileName(source.name);
  return {
    source,
    glb,
    project: {
      version: 1,
      kind: 'model',
      title,
      modelName: source.name,
      modelType: source.type || 'application/octet-stream',
      sourcePath,
      convertedPath,
      generalInstructions: '',
      annotations: [],
      viewpoints: [],
    },
  };
}

function tuple(vector: THREE.Vector3): ModelPoint {
  return [Number(vector.x.toFixed(6)), Number(vector.y.toFixed(6)), Number(vector.z.toFixed(6))];
}

function vector(value: ModelPoint) {
  return new THREE.Vector3(value[0], value[1], value[2]);
}

function cameraReference(modelRoot: THREE.Object3D, referenceMesh?: string) {
  if (!referenceMesh || referenceMesh === 'model-root') return modelRoot;
  let match: THREE.Object3D | undefined;
  modelRoot.traverse((child) => {
    if (!match && child.name === referenceMesh) match = child;
  });
  return match || modelRoot;
}

function captureCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, modelRoot: THREE.Object3D, referenceMesh = 'model-root'): ModelCamera {
  const reference = cameraReference(modelRoot, referenceMesh);
  reference.updateMatrixWorld(true);
  const inverse = reference.matrixWorld.clone().invert();
  const position = camera.position.clone().applyMatrix4(inverse);
  const target = controls.target.clone().applyMatrix4(inverse);
  const up = camera.up.clone().transformDirection(inverse);
  return { referenceMesh: reference === modelRoot ? 'model-root' : referenceMesh, position: tuple(position), target: tuple(target), up: tuple(up), fov: camera.fov };
}

function restoreCamera(state: ModelCamera, camera: THREE.PerspectiveCamera, controls: OrbitControls, modelRoot: THREE.Object3D) {
  const reference = cameraReference(modelRoot, state.referenceMesh);
  reference.updateMatrixWorld(true);
  camera.position.copy(vector(state.position).applyMatrix4(reference.matrixWorld));
  camera.up.copy(vector(state.up).transformDirection(reference.matrixWorld));
  camera.fov = state.fov;
  camera.updateProjectionMatrix();
  controls.target.copy(vector(state.target).applyMatrix4(reference.matrixWorld));
  controls.update();
}

function normalizeModel(model: THREE.Object3D, root: THREE.Group) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z) || 1;
  const scale = 4 / largest;
  model.position.sub(center);
  model.scale.multiplyScalar(scale);
  root.add(model);
  root.updateMatrixWorld(true);
}

function annotationMaterial(action: ModelAction, color: string, opacity?: number) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: opacity ?? (action === 'delete' ? 0.25 : 0.21),
    depthTest: false,
    depthWrite: false,
  });
}

function applyModelDisplayMode(root: THREE.Object3D, mode: ModelDisplayMode) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (!child.userData.cyannotaOriginalMaterial) {
      child.userData.cyannotaOriginalMaterial = child.material;
    }
    if (mode === 'textured') {
      child.material = child.userData.cyannotaOriginalMaterial;
      return;
    }
    const key = mode === 'solid' ? 'cyannotaSolidMaterial' : 'cyannotaWireframeMaterial';
    if (!child.userData[key]) {
      child.userData[key] = mode === 'solid'
        ? new THREE.MeshStandardMaterial({ color: '#aeb5bd', roughness: 0.82, metalness: 0.04, side: THREE.DoubleSide })
        : new THREE.MeshBasicMaterial({ color: '#dbe2ea', wireframe: true, transparent: true, opacity: 0.92 });
    }
    child.material = child.userData[key];
  });
}

function restoreAndDisposeModelDisplayMaterials(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const original = child.userData.cyannotaOriginalMaterial;
    const solid = child.userData.cyannotaSolidMaterial as THREE.Material | undefined;
    const wireframe = child.userData.cyannotaWireframeMaterial as THREE.Material | undefined;
    solid?.dispose();
    wireframe?.dispose();
    if (original) child.material = original;
    delete child.userData.cyannotaOriginalMaterial;
    delete child.userData.cyannotaSolidMaterial;
    delete child.userData.cyannotaWireframeMaterial;
  });
}

function actionLabel(action: ModelAction, locale: AppLocale) {
  return {
    camera: translate(locale, 'Do something in this view', 'Faire quelque chose dans cette vue'),
    modify: translate(locale, 'Do something here', 'Faire quelque chose ici'),
    delete: translate(locale, 'Delete this area', 'Supprimer cette partie'),
    recolor: translate(locale, 'Change the color here', 'Changer la couleur ici'),
    separate: translate(locale, 'Separate the mesh here', 'Séparer le mesh ici'),
  }[action];
}

export function buildModelPrompt(project: ModelProjectData, locale: AppLocale) {
  const lines = [
    translate(locale, '# 3D correction brief — ', '# Brief de corrections 3D — ') + project.title,
    '',
    translate(locale, 'Use `', 'Utilise `') + project.convertedPath + translate(locale, '` as the editable reference. Painted areas are approximate indications on the mesh, not exact masks.', '` comme référence éditable. Les zones peintes sont des indications approximatives sur le mesh, pas des masques stricts.'),
    '',
  ];
  if (project.generalInstructions.trim()) {
    lines.push(translate(locale, '## General instructions', '## Intention générale'), '', project.generalInstructions.trim(), '');
  }
  lines.push(translate(locale, '## Painted corrections', '## Corrections peintes'), '');
  project.annotations.forEach((annotation, index) => {
    const meshes = Array.from(new Set(annotation.points.map((point) => point.meshName).filter(Boolean)));
    lines.push(
      '### ' + String(index + 1).padStart(2, '0') + ' — ' + actionLabel(annotation.action, locale),
      '',
      '- ' + translate(locale, 'Instruction: ', 'Consigne : ') + (annotation.description.trim() || actionLabel(annotation.action, locale)),
      '- ' + translate(locale, 'Meshes: ', 'Meshes : ') + (meshes.join(', ') || translate(locale, 'camera view of the model', 'vue caméra du modèle')),
      '- ' + translate(locale, 'Paint samples: ', 'Échantillons de peinture : ') + annotation.points.length,
      '- ' + translate(locale, 'Camera relative to reference mesh: ', 'Caméra relative au mesh de référence : ') + JSON.stringify(annotation.camera),
      ...((annotation.views?.length || 0) > 1
        ? ['- ' + translate(locale, 'Camera views used while painting: ', 'Vues caméra utilisées pendant la peinture : ') + JSON.stringify(annotation.views)]
        : []),
      ...(annotation.action === 'recolor' ? ['- ' + translate(locale, 'Requested color: ', 'Couleur demandée : ') + annotation.targetColor] : []),
      '',
    );
  });
  if (project.viewpoints.length) {
    lines.push(translate(locale, '## Saved camera views', '## Vues caméra enregistrées'), '');
    project.viewpoints.forEach((view, index) => lines.push('- ' + String(index + 1).padStart(2, '0') + ' — ' + view.name + ': ' + JSON.stringify(view.camera)));
  }
  return lines.join('\n');
}

type ModelAnnotatorProps = {
  file: File;
  initialProject: ModelProjectData;
  onProjectChange: (project: ModelProjectData) => void;
  tabBar: ReactNode;
  workspaceStatus: string;
  workspaceBusy: boolean;
  onOpenWorkspace?: () => void;
  onAddImage?: () => void;
  onAddVideo?: () => void;
  onAddModel?: () => void;
  onSaveWorkspace: () => void;
  onExportWorkspace: () => void;
  onEditWorkspaceMessage: () => void;
  workspaceInstructions: string;
  locale: AppLocale;
  onLocaleChange: (locale: AppLocale) => void;
  integration?: { providerLabel: string; readOnly: boolean; onSend: () => void; onClose: () => void };
};

export default function ModelAnnotator({
  file,
  initialProject,
  onProjectChange,
  tabBar,
  workspaceStatus,
  workspaceBusy,
  onOpenWorkspace,
  onAddImage,
  onAddVideo,
  onAddModel,
  onSaveWorkspace,
  onExportWorkspace,
  onEditWorkspaceMessage,
  workspaceInstructions,
  locale,
  onLocaleChange,
  integration,
}: ModelAnnotatorProps) {
  const t = (english: string, french: string) => translate(locale, english, french);
  const [project, setProject] = useState(() => structuredClone(initialProject));
  const [tool, setTool] = useState<'orbit' | ModelAction>('orbit');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [brushRadius, setBrushRadius] = useState(0.055);
  const [paintColor, setPaintColor] = useState('#ff5c49');
  const [notice, setNotice] = useState(t('Loading model locally…', 'Chargement local du modèle…'));
  const [isPainting, setIsPainting] = useState(false);
  const [activePaintSession, setActivePaintSession] = useState<ModelAnnotation | null>(null);
  const [displayMode, setDisplayMode] = useState<ModelDisplayMode>('textured');
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const activePaintSessionRef = useRef<ModelAnnotation | null>(null);
  const lastStrokePointRef = useRef<ModelPaintPoint | null>(null);
  const isErasingRef = useRef(false);
  const displayModeRef = useRef<ModelDisplayMode>('textured');
  const projectRef = useRef(project);
  const selected = project.annotations.find((annotation) => annotation.id === selectedId) || null;

  function commit(next: ModelProjectData) {
    projectRef.current = next;
    setProject(next);
    onProjectChange(next);
  }

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    activePaintSessionRef.current = activePaintSession;
  }, [activePaintSession]);

  useEffect(() => {
    displayModeRef.current = displayMode;
    const runtime = runtimeRef.current;
    if (runtime) applyModelDisplayMode(runtime.modelRoot, displayMode);
  }, [displayMode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0d0f10');
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
    camera.position.set(4.8, 3.2, 5.8);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    host.replaceChildren(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    controls.target.set(0, 0, 0);
    controls.mouseButtons.LEFT = -1 as THREE.MOUSE;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    const modelRoot = new THREE.Group();
    const paintRoot = new THREE.Group();
    modelRoot.name = 'CyAnnotaModelRoot';
    paintRoot.name = 'CyAnnotaPaintRoot';
    scene.add(modelRoot, paintRoot);
    scene.add(new THREE.HemisphereLight(0xcfe7ff, 0x252019, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(5, 8, 6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffb9a7, 1.2);
    fill.position.set(-5, 1, -4);
    scene.add(fill);
    const grid = new THREE.GridHelper(10, 20, 0x343a40, 0x202428);
    grid.position.y = -2.05;
    scene.add(grid);
    const runtime: ViewerRuntime = {
      renderer,
      scene,
      camera,
      controls,
      modelRoot,
      paintRoot,
      raycaster: new THREE.Raycaster(),
      frame: 0,
    };
    runtimeRef.current = runtime;

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      runtime.frame = requestAnimationFrame(render);
    };
    render();

    file.arrayBuffer()
      .then((buffer) => parseGltfBuffer(new GLTFLoader(), buffer))
      .then((gltf) => {
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }
        normalizeModel(gltf.scene, modelRoot);
        applyModelDisplayMode(modelRoot, displayModeRef.current);
        setNotice(t('Model ready · paint directly on its surface', 'Modèle prêt · peins directement sur sa surface'));
      })
      .catch((error) => {
        if (!disposed) setNotice(t('Unable to display this converted GLB: ', 'Impossible d’afficher ce GLB converti : ') + String(error));
      });

    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(runtime.frame);
      controls.dispose();
      restoreAndDisposeModelDisplayMaterials(modelRoot);
      disposeObject(modelRoot);
      paintRoot.children.forEach((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
    // The viewer is recreated only when the model file changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.paintRoot.clear();
    runtime.paintRoot.visible = annotationsVisible;
    const sphere = new THREE.SphereGeometry(1, 10, 8);
    const annotations = activePaintSession
      ? [...project.annotations, activePaintSession]
      : project.annotations;
    annotations.forEach((annotation) => {
      const opacity = activePaintSession
        ? annotation.id === activePaintSession.id ? 0.34 : 0.07
        : annotation.id === selectedId ? 0.28 : annotation.action === 'delete' ? 0.23 : 0.19;
      const material = annotationMaterial(annotation.action, annotation.color, opacity);
      annotation.points.forEach((point) => {
        const marker = new THREE.Mesh(sphere, material);
        marker.position.copy(vector(point.position).applyMatrix4(runtime.modelRoot.matrixWorld));
        marker.scale.setScalar(annotation.radius);
        marker.renderOrder = 20;
        runtime.paintRoot.add(marker);
      });
    });
    return () => {
      sphere.dispose();
      const materials = new Set<THREE.Material>();
      runtime.paintRoot.children.forEach((child) => {
        if (child instanceof THREE.Mesh) materials.add(child.material as THREE.Material);
      });
      materials.forEach((material) => material.dispose());
    };
  }, [activePaintSession, annotationsVisible, project.annotations, selectedId]);

  const pointerPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const runtime = runtimeRef.current;
    const host = hostRef.current;
    if (!runtime || !host || !activePaintSessionRef.current) return null;
    const bounds = host.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    runtime.raycaster.setFromCamera(pointer, runtime.camera);
    const hit = runtime.raycaster.intersectObject(runtime.modelRoot, true).find((item) => item.object instanceof THREE.Mesh);
    if (!hit) return null;
    const localPoint = runtime.modelRoot.worldToLocal(hit.point.clone());
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
    const worldNormal = (hit.face?.normal || new THREE.Vector3(0, 1, 0)).clone().applyMatrix3(normalMatrix).normalize();
    const localNormal = worldNormal.transformDirection(runtime.modelRoot.matrixWorld.clone().invert());
    return {
      position: tuple(localPoint),
      normal: tuple(localNormal),
      meshName: hit.object.name || hit.object.parent?.name || 'unnamed-mesh',
      faceIndex: hit.faceIndex ?? undefined,
    } satisfies ModelPaintPoint;
  };

  function setActiveDraft(annotation: ModelAnnotation | null) {
    activePaintSessionRef.current = annotation;
    setActivePaintSession(annotation);
  }

  function startPaintSession(action: Exclude<ModelAction, 'camera'>) {
    const runtime = runtimeRef.current;
    if (!runtime || activePaintSessionRef.current) return;
    const camera = captureCamera(runtime.camera, runtime.controls, runtime.modelRoot);
    const color = MODEL_ACTION_COLORS[action];
    const annotation: ModelAnnotation = {
      id: createId(),
      action,
      color,
      targetColor: action === 'recolor' ? '#65d195' : '',
      description: '',
      radius: brushRadius,
      points: [],
      camera,
      views: [],
      createdAt: currentTimestamp(),
    };
    setSelectedId(null);
    setPaintColor(color);
    setAnnotationsVisible(true);
    setTool(action);
    setActiveDraft(annotation);
    setNotice(t('Annotation active · paint from several views, then validate', 'Annotation active · peins depuis plusieurs vues, puis valide'));
  }

  function appendStrokePoint(point: ModelPaintPoint) {
    const draft = activePaintSessionRef.current;
    if (!draft) return;
    const previous = lastStrokePointRef.current;
    if (previous && vector(previous.position).distanceTo(vector(point.position)) < brushRadius * 0.5) return;
    lastStrokePointRef.current = point;
    setActiveDraft({
      ...draft,
      color: paintColor,
      radius: brushRadius,
      points: [...draft.points, point],
    });
  }

  function eraseStrokePoint(point: ModelPaintPoint) {
    const draft = activePaintSessionRef.current;
    if (!draft) return;
    const eraseRadius = Math.max(brushRadius, draft.radius) * 1.35;
    const points = draft.points.filter((paintPoint) =>
      vector(paintPoint.position).distanceTo(vector(point.position)) > eraseRadius,
    );
    if (points.length !== draft.points.length) {
      setActiveDraft({ ...draft, points });
      setNotice(t('Paint erased from the active annotation', 'Peinture effacée dans l’annotation active'));
    }
  }

  function recordStrokeView(referenceMesh: string) {
    const runtime = runtimeRef.current;
    const draft = activePaintSessionRef.current;
    if (!runtime || !draft) return;
    const view = captureCamera(runtime.camera, runtime.controls, runtime.modelRoot, referenceMesh);
    const views = [...(draft.views || []), view];
    setActiveDraft({ ...draft, camera: views[0] || view, views });
  }

  function finishPointerStroke() {
    setIsPainting(false);
    lastStrokePointRef.current = null;
    isErasingRef.current = false;
  }

  function endPaintSession() {
    const draft = activePaintSessionRef.current;
    if (!draft) return;
    if (!draft.points.length) {
      setNotice(t('Paint at least one area before ending the annotation', 'Peins au moins une zone avant de terminer l’annotation'));
      return;
    }
    commit({ ...projectRef.current, annotations: [...projectRef.current.annotations, draft] });
    setSelectedId(draft.id);
    setActiveDraft(null);
    setTool('orbit');
    finishPointerStroke();
    setNotice(t('Annotation validated · navigation mode restored', 'Annotation validée · mode déplacement rétabli'));
  }

  function cancelPaintSession() {
    if (!activePaintSessionRef.current) return;
    setActiveDraft(null);
    setTool('orbit');
    finishPointerStroke();
    setNotice(t('Annotation cancelled', 'Annotation annulée'));
  }

  function updateSelected(patch: Partial<ModelAnnotation>) {
    if (!selectedId) return;
    commit({
      ...projectRef.current,
      annotations: projectRef.current.annotations.map((annotation) => annotation.id === selectedId ? { ...annotation, ...patch } : annotation),
    });
  }

  function saveViewpoint() {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.renderer.render(runtime.scene, runtime.camera);
    const view: ModelViewpoint = {
      id: createId(),
      name: t('View ', 'Vue ') + String(projectRef.current.viewpoints.length + 1).padStart(2, '0'),
      camera: captureCamera(runtime.camera, runtime.controls, runtime.modelRoot),
      snapshot: runtime.renderer.domElement.toDataURL('image/png'),
      createdAt: currentTimestamp(),
    };
    commit({ ...projectRef.current, viewpoints: [...projectRef.current.viewpoints, view] });
    setNotice(t('Camera view saved relative to the model', 'Vue caméra enregistrée relativement au modèle'));
  }

  function createCameraAnnotation() {
    const runtime = runtimeRef.current;
    if (!runtime || activePaintSessionRef.current) return;
    const camera = captureCamera(runtime.camera, runtime.controls, runtime.modelRoot);
    const annotation: ModelAnnotation = {
      id: createId(),
      action: 'camera',
      color: '#71b9ff',
      targetColor: '',
      description: '',
      radius: brushRadius,
      points: [],
      camera,
      views: [camera],
      createdAt: currentTimestamp(),
    };
    commit({ ...projectRef.current, annotations: [...projectRef.current.annotations, annotation] });
    setSelectedId(annotation.id);
    setNotice(t('Correction attached to the current camera view', 'Correction attachée à la vue caméra actuelle'));
  }

  const actionTools = useMemo(() => ([
    { id: 'modify' as const, icon: '✎', en: 'Do something here', fr: 'Faire quelque chose ici' },
    { id: 'delete' as const, icon: '⌫', en: 'Delete this area', fr: 'Supprimer cette partie' },
    { id: 'recolor' as const, icon: '◉', en: 'Change color here', fr: 'Changer la couleur ici' },
    { id: 'separate' as const, icon: '✂', en: 'Separate mesh here', fr: 'Séparer le mesh ici' },
  ]), []);

  return (
    <main className="model-shell">
      <header className="model-topbar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-mark" src="/cyannota-logo.png" alt="" />
          <div><strong>CyAnnota 3D</strong><span className="brand-subtitle">{t('Local mesh annotations', 'Annotations locales de mesh')}</span><VersionStatus locale={locale} /></div>
        </div>
        <button className={'button ghost compact workspace-message-button' + (workspaceInstructions.trim() ? ' active' : '')} onClick={onEditWorkspaceMessage}>{t('Global message', 'Message global')}</button>
        <label className="model-title"><input value={project.title} aria-label={t('Model project name', 'Nom du projet 3D')} onChange={(event: ChangeEvent<HTMLInputElement>) => commit({ ...projectRef.current, title: event.target.value })} /></label>
        <div className="top-actions">
          <label className="language-picker" title={t('Interface and prompt language', 'Langue de l’interface et des prompts')}><span>{locale.toUpperCase()}</span><select value={locale} onChange={(event) => onLocaleChange(event.target.value as AppLocale)}><option value="en">English</option><option value="fr">Français</option></select></label>
          {integration ? <span className="cytask-bridge-badge">{integration.providerLabel + (integration.readOnly ? ' · consultation' : ' · lié')}</span> : <>
            <button className="button ghost compact" onClick={onOpenWorkspace}>{t('Open', 'Ouvrir')}</button>
            <button className="button ghost compact" onClick={onAddImage}>{t('Image', 'Image')}</button>
            <button className="button ghost compact" onClick={onAddVideo}>{t('Video', 'Vidéo')}</button>
            <button className="button ghost compact" onClick={onAddModel}>3D</button>
          </>}
          {integration ? <><button className="button ghost compact" onClick={integration.onClose}>{t('Close', 'Fermer')}</button>{!integration.readOnly && <button className="button primary" onClick={integration.onSend} disabled={workspaceBusy}>{t('Send', 'Envoyer')}</button>}</> : <><button className="button ghost compact" onClick={onSaveWorkspace} disabled={workspaceBusy}>{t('Save', 'Sauver')}</button><button className="button primary" onClick={onExportWorkspace}>{t('Export', 'Exporter')}</button></>}
        </div>
      </header>
      {tabBar}
      <section className="model-workspace">
        <aside className="model-tools" aria-label={t('3D annotation tools', 'Outils d’annotation 3D')}>
          <button className={'model-tool ' + (tool === 'orbit' ? 'active' : '')} disabled={Boolean(activePaintSession)} onClick={() => setTool('orbit')}><span>✥</span><strong>{t('Navigate', 'Naviguer')}</strong><small>{t('Orbit and zoom', 'Orbite et zoom')}</small></button>
          <button className="model-tool" disabled={Boolean(activePaintSession)} onClick={createCameraAnnotation}><span>◫</span><strong>{t('Annotate this view', 'Annoter cette vue')}</strong><small>{t('Attach a request to the current camera', 'Attacher une demande à la caméra actuelle')}</small></button>
          {actionTools.map((item) => <button key={item.id} className={'model-tool ' + (tool === item.id ? 'active' : '')} disabled={Boolean(activePaintSession)} onClick={() => startPaintSession(item.id)}><span>{item.icon}</span><strong>{t(item.en, item.fr)}</strong><small>{t('Start one multi-view paint annotation', 'Commencer une annotation peinte multi-vues')}</small></button>)}
          <label className="model-brush"><span>{t('Brush size', 'Taille du pinceau')}</span><input type="range" min="0.015" max="0.18" step="0.005" value={brushRadius} onChange={(event) => { const radius = Number(event.target.value); setBrushRadius(radius); const draft = activePaintSessionRef.current; if (draft) setActiveDraft({ ...draft, radius }); }} /></label>
          <label className="model-brush"><span>{t('Mark color', 'Couleur du marquage')}</span><input type="color" value={paintColor} onChange={(event) => { const color = event.target.value; setPaintColor(color); const draft = activePaintSessionRef.current; if (draft) setActiveDraft({ ...draft, color }); }} /></label>
          {activePaintSession && <section className="model-session-panel" aria-live="polite">
            <strong>{t('Annotation in progress', 'Annotation en cours')}</strong>
            <span>{actionLabel(activePaintSession.action, locale)} · {activePaintSession.points.length} {t('paint samples', 'points peints')}</span>
            <ul>
              <li>{t('Left drag: paint', 'Clic gauche glissé : peindre')}</li>
              <li>{t('Ctrl + left drag: erase paint', 'Ctrl + clic gauche glissé : effacer')}</li>
              <li>{t('Middle drag: move the view', 'Clic molette glissé : déplacer la vue')}</li>
              <li>{t('Right drag: orbit camera', 'Clic droit glissé : tourner la caméra')}</li>
              <li>{t('Wheel: zoom', 'Molette : zoomer')}</li>
            </ul>
            <div className="model-session-actions">
              <button className="button primary" onClick={endPaintSession}>{t('End annotation', 'Terminer l’annotation')}</button>
              <button className="button ghost" onClick={cancelPaintSession}>{t('Cancel', 'Annuler')}</button>
            </div>
          </section>}
          <button className="button ghost" onClick={saveViewpoint}>{t('Save camera view', 'Enregistrer la vue caméra')}</button>
        </aside>
        <section className="model-stage">
          <div className="model-controls-help" aria-label={t('3D controls', 'Commandes 3D')}>
            <strong>{t('Controls', 'Commandes')}</strong>
            {activePaintSession && <><span>{t('Left drag', 'Clic gauche glissé')} — {t('Paint', 'Peindre')}</span><span>Ctrl + {t('left drag', 'clic gauche glissé')} — {t('Erase', 'Effacer')}</span></>}
            <span>{t('Middle drag', 'Clic molette glissé')} — {t('Move view', 'Déplacer la vue')}</span>
            <span>{t('Right drag', 'Clic droit glissé')} — {t('Orbit', 'Orbite')}</span>
            <span>{t('Wheel', 'Molette')} — Zoom</span>
          </div>
          <div className="model-view-modes" aria-label={t('3D display mode', 'Mode d’affichage 3D')}>
            <button className={annotationsVisible ? '' : 'active'} onClick={() => setAnnotationsVisible((visible) => !visible)}>{annotationsVisible ? t('Hide marks', 'Masquer annotations') : t('Show marks', 'Afficher annotations')}</button>
            {([
              ['textured', t('Textured', 'Texturé')],
              ['solid', t('Solid', 'Solide')],
              ['wireframe', 'Wireframe'],
            ] as Array<[ModelDisplayMode, string]>).map(([mode, label]) => (
              <button key={mode} className={displayMode === mode ? 'active' : ''} onClick={() => setDisplayMode(mode)}>{label}</button>
            ))}
          </div>
          <div
            ref={hostRef}
            className={'model-canvas ' + (activePaintSession ? 'is-painting-tool' : 'is-orbit')}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (!activePaintSessionRef.current || event.button !== 0) return;
              const point = pointerPoint(event);
              if (!point) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              lastStrokePointRef.current = null;
              isErasingRef.current = event.ctrlKey;
              setIsPainting(true);
              if (isErasingRef.current) eraseStrokePoint(point);
              else {
                recordStrokeView(point.meshName);
                appendStrokePoint(point);
              }
            }}
            onPointerMove={(event) => {
              if (!isPainting) return;
              const point = pointerPoint(event);
              if (!point) return;
              if (isErasingRef.current || event.ctrlKey) eraseStrokePoint(point);
              else appendStrokePoint(point);
            }}
            onPointerUp={finishPointerStroke}
            onPointerCancel={finishPointerStroke}
          />
          <div className="model-stage-status"><span>{notice}</span><span>{project.annotations.length} {t('painted correction(s)', 'correction(s) peinte(s)')} · {project.viewpoints.length} {t('camera view(s)', 'vue(s) caméra')}</span></div>
        </section>
        <aside className="model-inspector">
          <label><span>{t('General model message', 'Message général du modèle')}</span><textarea value={project.generalInstructions} placeholder={t('Instructions for the whole model…', 'Instructions pour l’ensemble du modèle…')} onChange={(event) => commit({ ...projectRef.current, generalInstructions: event.target.value })} /></label>
          <div className="model-inspector-heading"><strong>{t('Painted corrections', 'Corrections peintes')}</strong><span>{project.annotations.length}</span></div>
          <div className="model-annotation-list">
            {project.annotations.map((annotation, index) => <button key={annotation.id} disabled={Boolean(activePaintSession)} className={'model-annotation-row ' + (annotation.id === selectedId ? 'active' : '')} onClick={() => { setSelectedId(annotation.id); const runtime = runtimeRef.current; if (runtime) restoreCamera(annotation.camera, runtime.camera, runtime.controls, runtime.modelRoot); }}><span style={{ background: annotation.color }}>{String(index + 1).padStart(2, '0')}</span><div><strong>{actionLabel(annotation.action, locale)}</strong><small>{annotation.action === 'camera' ? t('camera view', 'vue caméra') : annotation.points.length + ' ' + t('paint samples', 'points peints')}</small></div></button>)}
          </div>
          {selected && <div className="model-selected-editor">
            <label><span>{t('Action', 'Action')}</span><select value={selected.action} onChange={(event) => updateSelected({ action: event.target.value as ModelAction })}><option value="camera">{t('Do something in this view', 'Faire quelque chose dans cette vue')}</option>{actionTools.map((item) => <option key={item.id} value={item.id}>{t(item.en, item.fr)}</option>)}</select></label>
            <label><span>{t('Message', 'Message')}</span><textarea value={selected.description} placeholder={actionLabel(selected.action, locale)} onChange={(event) => updateSelected({ description: event.target.value })} /></label>
            {selected.action === 'recolor' && <label><span>{t('Requested color', 'Couleur demandée')}</span><input type="color" value={selected.targetColor || '#65d195'} onChange={(event) => updateSelected({ targetColor: event.target.value })} /></label>}
            <button className="button danger" onClick={() => { commit({ ...projectRef.current, annotations: projectRef.current.annotations.filter((annotation) => annotation.id !== selected.id) }); setSelectedId(null); }}>{t('Delete this correction', 'Supprimer cette correction')}</button>
          </div>}
          {project.viewpoints.length > 0 && <>
            <div className="model-inspector-heading"><strong>{t('Camera views', 'Vues caméra')}</strong><span>{project.viewpoints.length}</span></div>
            <div className="model-view-list">
              {project.viewpoints.map((view) => <button key={view.id} onClick={() => {
                const runtime = runtimeRef.current;
                if (runtime) restoreCamera(view.camera, runtime.camera, runtime.controls, runtime.modelRoot);
              }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={view.snapshot} alt="" />
                <span>{view.name}</span>
              </button>)}
            </div>
          </>}
          <footer>{workspaceStatus}</footer>
        </aside>
      </section>
    </main>
  );
}
