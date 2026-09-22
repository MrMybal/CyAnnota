/*
 * CyAnnota AI Authoring SDK
 * Copyright (c) 2026 CyberAlien
 * SPDX-License-Identifier: MIT
 */
(function exposeCyAnnotaAi(global) {
  'use strict';

  var FORMAT = 'cyannota-ai';
  var VERSION = 1;
  var IMAGE_TYPES = ['box', 'arrow', 'note', 'freehand', 'delete', 'color', 'frame', 'shape'];
  var VIDEO_TYPES = ['box', 'arrow', 'note', 'freehand'];
  var CATEGORIES = ['modifier', 'ajouter', 'supprimer', 'deplacer', 'question'];

  function clone(value) {
    return typeof global.structuredClone === 'function'
      ? global.structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function id(prefix) {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return prefix + '-' + global.crypto.randomUUID();
    }
    return prefix + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function clamp(value, minimum, maximum) {
    var number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : minimum;
  }

  function safeName(value) {
    return String(value || 'cyannota')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'cyannota';
  }

  function extension(name, type) {
    var match = String(name || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    if (match) return match[1];
    return ({
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
      'video/mp4': 'mp4', 'video/webm': 'webm',
    })[String(type || '').toLowerCase()] || 'bin';
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('Impossible de lire le média.')); };
      reader.readAsDataURL(blob);
    });
  }

  function zipApi(options) {
    var api = options && options.JSZip || global.JSZip;
    if (api && api.default) api = api.default;
    if (!api || typeof api.loadAsync !== 'function') {
      throw new Error('JSZip est requis. Passez { JSZip } à l’API CyAnnotaAI.');
    }
    return api;
  }

  function createDocument(options) {
    options = options || {};
    return {
      format: FORMAT,
      version: VERSION,
      title: String(options.title || 'AI annotations'),
      locale: options.locale === 'fr' ? 'fr' : 'en',
      workspaceMessage: String(options.workspaceMessage || ''),
      tabs: Array.isArray(options.tabs) ? clone(options.tabs) : [],
    };
  }

  function validatePoint(point, path, errors) {
    if (!point || typeof point !== 'object') {
      errors.push(path + ' doit être un point { x, y }.');
      return;
    }
    ['x', 'y'].forEach(function (key) {
      if (!Number.isFinite(point[key]) || point[key] < 0 || point[key] > 1) {
        errors.push(path + '.' + key + ' doit être compris entre 0 et 1.');
      }
    });
  }

  function validateAnnotation(annotation, path, tab, errors) {
    if (!annotation || typeof annotation !== 'object') {
      errors.push(path + ' doit être un objet.');
      return;
    }
    var allowed = tab.kind === 'image' ? IMAGE_TYPES : VIDEO_TYPES;
    if (allowed.indexOf(annotation.type) < 0) errors.push(path + '.type n’est pas compatible avec cet onglet.');
    if (typeof annotation.message !== 'string') errors.push(path + '.message doit être une chaîne.');
    if (annotation.category !== undefined && CATEGORIES.indexOf(annotation.category) < 0) {
      errors.push(path + '.category est invalide.');
    }
    if (tab.kind !== 'image') {
      if (!annotation.time || !Number.isFinite(annotation.time.start) || !Number.isFinite(annotation.time.end)) {
        errors.push(path + '.time doit contenir start et end en secondes.');
      } else if (annotation.time.start < 0 || annotation.time.end < annotation.time.start || annotation.time.end > tab.duration) {
        errors.push(path + '.time sort de la durée du média.');
      }
    }
    if (['box', 'delete', 'frame', 'shape'].indexOf(annotation.type) >= 0) {
      var box = annotation.box;
      if (!box || typeof box !== 'object') errors.push(path + '.box est requis.');
      else {
        validatePoint({ x: box.x, y: box.y }, path + '.box', errors);
        if (!Number.isFinite(box.width) || box.width <= 0 || box.width > 1) errors.push(path + '.box.width doit être dans ]0, 1].');
        if (!Number.isFinite(box.height) || box.height <= 0 || box.height > 1) errors.push(path + '.box.height doit être dans ]0, 1].');
      }
    } else if (annotation.type === 'arrow') {
      validatePoint(annotation.from, path + '.from', errors);
      validatePoint(annotation.to, path + '.to', errors);
    } else if (annotation.type === 'note' || annotation.type === 'color') {
      validatePoint(annotation.point, path + '.point', errors);
    } else if (annotation.type === 'freehand') {
      if (!Array.isArray(annotation.points) || annotation.points.length < 2) errors.push(path + '.points doit contenir au moins deux points.');
      else annotation.points.forEach(function (point, index) { validatePoint(point, path + '.points[' + index + ']', errors); });
    }
  }

  function validateDocument(document) {
    var errors = [];
    if (!document || typeof document !== 'object') return { valid: false, errors: ['Le document est absent.'] };
    if (document.format !== FORMAT) errors.push('format doit valoir « ' + FORMAT + ' ».');
    if (document.version !== VERSION) errors.push('version doit valoir ' + VERSION + '.');
    if (!Array.isArray(document.tabs) || document.tabs.length === 0) errors.push('tabs doit contenir au moins un onglet.');
    var tabIds = new Set();
    (Array.isArray(document.tabs) ? document.tabs : []).forEach(function (tab, tabIndex) {
      var path = 'tabs[' + tabIndex + ']';
      if (!tab || typeof tab !== 'object') { errors.push(path + ' doit être un objet.'); return; }
      if (tab.kind !== 'image' && tab.kind !== 'video' && tab.kind !== 'gif') errors.push(path + '.kind est invalide.');
      if (!tab.id || typeof tab.id !== 'string') errors.push(path + '.id est requis.');
      else if (tabIds.has(tab.id)) errors.push(path + '.id doit être unique.');
      else tabIds.add(tab.id);
      if (!Number.isFinite(tab.width) || tab.width <= 0) errors.push(path + '.width doit être positif.');
      if (!Number.isFinite(tab.height) || tab.height <= 0) errors.push(path + '.height doit être positif.');
      if (tab.kind !== 'image' && (!Number.isFinite(tab.duration) || tab.duration <= 0)) errors.push(path + '.duration doit être positive.');
      if (!Array.isArray(tab.annotations)) errors.push(path + '.annotations doit être un tableau.');
      else tab.annotations.forEach(function (annotation, annotationIndex) {
        validateAnnotation(annotation, path + '.annotations[' + annotationIndex + ']', tab, errors);
      });
    });
    return { valid: errors.length === 0, errors: errors };
  }

  function requireValid(document) {
    var result = validateDocument(document);
    if (!result.valid) throw new Error('Document CyAnnota AI invalide :\n- ' + result.errors.join('\n- '));
  }

  function tabById(document, tabId) {
    var tab = document.tabs.find(function (candidate) { return candidate.id === tabId; });
    if (!tab) throw new Error('Onglet CyAnnota introuvable : ' + tabId);
    return tab;
  }

  function applyOperations(source, operations) {
    var document = clone(source);
    if (!Array.isArray(operations)) throw new Error('operations doit être un tableau.');
    operations.forEach(function (operation, index) {
      if (!operation || typeof operation !== 'object') throw new Error('Opération #' + (index + 1) + ' invalide.');
      if (operation.op === 'set-title') document.title = String(operation.value || '');
      else if (operation.op === 'set-workspace-message') document.workspaceMessage = String(operation.value || '');
      else {
        var tab = tabById(document, operation.tabId);
        if (operation.op === 'set-tab-message') tab.message = String(operation.value || '');
        else if (operation.op === 'add-annotation') {
          var added = clone(operation.annotation || {});
          if (!added.id) added.id = id('annotation');
          tab.annotations.push(added);
        } else {
          var annotationIndex = tab.annotations.findIndex(function (annotation) { return annotation.id === operation.annotationId; });
          if (annotationIndex < 0) throw new Error('Annotation introuvable : ' + operation.annotationId);
          if (operation.op === 'remove-annotation') tab.annotations.splice(annotationIndex, 1);
          else if (operation.op === 'update-annotation') {
            tab.annotations[annotationIndex] = Object.assign({}, tab.annotations[annotationIndex], clone(operation.patch || {}), {
              id: tab.annotations[annotationIndex].id,
            });
          } else throw new Error('Opération non prise en charge : ' + operation.op);
        }
      }
    });
    requireValid(document);
    return document;
  }

  function pixelPoint(point, tab) {
    return { x: clamp(point.x, 0, 1) * tab.width, y: clamp(point.y, 0, 1) * tab.height };
  }

  function baseAnnotation(annotation, layerId) {
    return {
      id: annotation.id || id('annotation'),
      layerId: annotation.layerId || layerId,
      color: annotation.color || '#ff5c49',
      description: String(annotation.message || ''),
      category: CATEGORIES.indexOf(annotation.category) >= 0 ? annotation.category : 'modifier',
      references: [],
      createdAt: Number.isFinite(annotation.createdAt) ? annotation.createdAt : Date.now(),
      groupId: annotation.groupId || undefined,
    };
  }

  function imageAnnotation(annotation, tab, layerId) {
    var base = baseAnnotation(annotation, layerId);
    if (annotation.type === 'box' || annotation.type === 'delete' || annotation.type === 'frame' || annotation.type === 'shape') {
      var origin = pixelPoint(annotation.box, tab);
      var box = { x: origin.x, y: origin.y, w: annotation.box.width * tab.width, h: annotation.box.height * tab.height };
      if (annotation.type === 'box') return Object.assign(base, box, { type: 'rect' });
      if (annotation.type === 'delete') return Object.assign(base, box, { type: 'delete', category: 'supprimer' });
      if (annotation.type === 'frame') return Object.assign(base, box, { type: 'frame' });
      return Object.assign(base, box, {
        type: 'shape', shape: annotation.shape || 'rectangle', fillColor: annotation.fillColor || 'transparent',
      });
    }
    if (annotation.type === 'arrow') {
      var from = pixelPoint(annotation.from, tab);
      var to = pixelPoint(annotation.to, tab);
      return Object.assign(base, { type: 'arrow', x1: from.x, y1: from.y, x2: to.x, y2: to.y });
    }
    if (annotation.type === 'note') {
      var note = pixelPoint(annotation.point, tab);
      return Object.assign(base, { type: 'text', x: note.x, y: note.y });
    }
    if (annotation.type === 'freehand') {
      return Object.assign(base, { type: 'draw', points: annotation.points.map(function (point) { return pixelPoint(point, tab); }) });
    }
    var colorPoint = pixelPoint(annotation.point, tab);
    return Object.assign(base, {
      type: 'color', x: colorPoint.x, y: colorPoint.y,
      sampledColor: annotation.sampledColor || '#000000', replacementColor: annotation.replacementColor || '#ffffff',
    });
  }

  function videoAnnotation(annotation, tab) {
    var output = {
      id: annotation.id || id('annotation'),
      type: annotation.type === 'box' ? 'rect' : annotation.type === 'note' ? 'note' : annotation.type === 'freehand' ? 'draw' : 'arrow',
      start: clamp(annotation.time.start, 0, tab.duration),
      end: clamp(annotation.time.end, 0, tab.duration),
      color: annotation.color || '#ff5c49',
      message: String(annotation.message || ''),
    };
    if (annotation.type === 'box') {
      var origin = pixelPoint(annotation.box, tab);
      output.x = origin.x; output.y = origin.y;
      output.w = annotation.box.width * tab.width; output.h = annotation.box.height * tab.height;
    } else if (annotation.type === 'arrow') {
      var from = pixelPoint(annotation.from, tab); var to = pixelPoint(annotation.to, tab);
      output.x = from.x; output.y = from.y; output.x2 = to.x; output.y2 = to.y;
    } else if (annotation.type === 'note') {
      var point = pixelPoint(annotation.point, tab); output.x = point.x; output.y = point.y;
    } else output.points = annotation.points.map(function (point) { return pixelPoint(point, tab); });
    return output;
  }

  function mediaFor(media, tabId) {
    if (media instanceof Map) return media.get(tabId);
    return media && media[tabId];
  }

  async function compileWorkspace(document, options) {
    requireValid(document);
    options = options || {};
    var media = options.media || {};
    var storedTabs = [];
    var mediaEntries = [];
    for (var index = 0; index < document.tabs.length; index += 1) {
      var tab = document.tabs[index];
      var blob = mediaFor(media, tab.id);
      if (!(blob instanceof Blob)) throw new Error('Média Blob/File manquant pour l’onglet « ' + tab.id + ' ».');
      var mediaName = String(tab.mediaName || blob.name || (tab.kind === 'image' ? 'image.png' : tab.kind === 'gif' ? 'animation.gif' : 'video.mp4'));
      var folder = 'tabs/' + String(index + 1).padStart(2, '0') + '-' + safeName(tab.label || tab.id) + '/';
      var mediaPath = folder + 'media/source.' + extension(mediaName, blob.type);
      var tabCopy = clone(tab);
      tabCopy.mediaPath = mediaPath;
      document.tabs[index].mediaPath = mediaPath;
      mediaEntries.push({ path: mediaPath, blob: blob });
      if (tab.kind === 'image') {
        var layerId = 'ai-corrections';
        storedTabs.push({
          id: tab.id,
          label: String(tab.label || mediaName),
          kind: 'image',
          project: {
            version: 1,
            title: String(tab.label || document.title),
            globalInstructions: String(tab.message || ''),
            image: { src: await blobToDataUrl(blob), name: mediaName },
            layers: [{ id: layerId, name: document.locale === 'fr' ? 'Corrections IA' : 'AI corrections', color: '#ff5c49', visible: true }],
            annotations: tab.annotations.map(function (annotation) { return imageAnnotation(annotation, tab, layerId); }),
          },
        });
      } else {
        var sourceName = 'source.' + extension(mediaName, blob.type);
        storedTabs.push({
          id: tab.id,
          label: String(tab.label || mediaName),
          kind: 'video',
          sourcePath: mediaPath,
          project: {
            version: 1,
            kind: 'video',
            title: String(tab.label || document.title),
            videoName: mediaName,
            videoType: blob.type || (tab.kind === 'gif' ? 'image/gif' : 'video/mp4'),
            duration: tab.duration,
            sourcePath: sourceName,
            generalInstructions: String(tab.message || ''),
            annotations: tab.annotations.map(function (annotation) { return videoAnnotation(annotation, tab); }),
            trimStart: Number.isFinite(tab.trimStart) ? tab.trimStart : 0,
            trimEnd: Number.isFinite(tab.trimEnd) ? tab.trimEnd : tab.duration,
          },
        });
      }
    }
    return {
      document: document,
      workspace: {
        workspaceVersion: 2,
        locale: document.locale,
        workspaceInstructions: String(document.workspaceMessage || ''),
        activeTabId: storedTabs[0].id,
        tabs: storedTabs,
      },
      mediaEntries: mediaEntries,
    };
  }

  async function createPackage(source, options) {
    options = options || {};
    var JSZipApi = zipApi(options);
    var document = clone(source);
    var compiled = await compileWorkspace(document, options);
    var zip = new JSZipApi();
    compiled.mediaEntries.forEach(function (entry) { zip.file(entry.path, entry.blob); });
    zip.file('workspace.cyannota.json', JSON.stringify(compiled.workspace, null, 2));
    zip.file('ai-source.cyannota.json', JSON.stringify(compiled.document, null, 2));
    var imageCount = document.tabs.filter(function (tab) { return tab.kind === 'image'; }).length;
    var videoCount = document.tabs.length - imageCount;
    var annotationCount = document.tabs.reduce(function (sum, tab) { return sum + tab.annotations.length; }, 0);
    var thumbnail = options.thumbnail instanceof Blob ? options.thumbnail : null;
    if (!thumbnail) {
      var firstImage = document.tabs.find(function (tab) { return tab.kind === 'image'; });
      thumbnail = firstImage ? mediaFor(options.media || {}, firstImage.id) : null;
    }
    var thumbnailPath = null;
    if (thumbnail instanceof Blob) {
      thumbnailPath = 'thumbnail.' + extension(thumbnail.name, thumbnail.type);
      zip.file(thumbnailPath, thumbnail);
    }
    var manifest = {
      format: 'cyannota-project', formatVersion: 1, title: document.title,
      updatedAt: new Date().toISOString(), container: 'project', audience: options.audience === 'human' ? 'human' : 'ai',
      locale: document.locale, workspace: 'workspace.cyannota.json', thumbnail: thumbnailPath,
      activeTabId: compiled.workspace.activeTabId, tabCount: document.tabs.length,
      imageCount: imageCount, videoCount: videoCount, correctionCount: annotationCount,
      imageOptimization: null, sourceApplication: 'CyAnnotaAI', aiSource: 'ai-source.cyannota.json',
    };
    zip.file('manifest.cyannota.json', JSON.stringify(manifest, null, 2));
    var archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    archive = new Blob([archive], { type: 'application/x-cyannota' });
    return {
      archive: archive,
      archiveName: safeName(document.title) + '.cyannota',
      document: compiled.document,
      workspace: compiled.workspace,
      manifest: manifest,
      thumbnail: thumbnail,
      summary: {
        title: document.title, tabCount: document.tabs.length, imageCount: imageCount,
        videoCount: videoCount, annotationCount: annotationCount,
      },
    };
  }

  function normalizedPoint(x, y, width, height) {
    return { x: clamp(Number(x) / width, 0, 1), y: clamp(Number(y) / height, 0, 1) };
  }

  function aiImageAnnotation(annotation, width, height) {
    var output = {
      id: annotation.id,
      message: String(annotation.description || ''),
      category: CATEGORIES.indexOf(annotation.category) >= 0 ? annotation.category : 'modifier',
      color: annotation.color || '#ff5c49',
      groupId: annotation.groupId || undefined,
      createdAt: annotation.createdAt,
    };
    if (annotation.type === 'arrow') {
      output.type = 'arrow';
      output.from = normalizedPoint(annotation.x1, annotation.y1, width, height);
      output.to = normalizedPoint(annotation.x2, annotation.y2, width, height);
    } else if (annotation.type === 'text') {
      output.type = 'note'; output.point = normalizedPoint(annotation.x, annotation.y, width, height);
    } else if (annotation.type === 'draw') {
      output.type = 'freehand';
      output.points = (annotation.points || []).map(function (point) { return normalizedPoint(point.x, point.y, width, height); });
    } else if (annotation.type === 'color') {
      output.type = 'color'; output.point = normalizedPoint(annotation.x, annotation.y, width, height);
      output.sampledColor = annotation.sampledColor; output.replacementColor = annotation.replacementColor;
    } else {
      output.type = annotation.type === 'delete' ? 'delete' : annotation.type === 'frame' ? 'frame' : annotation.type === 'shape' ? 'shape' : 'box';
      output.box = Object.assign(normalizedPoint(annotation.x, annotation.y, width, height), {
        width: clamp(Number(annotation.w || annotation.sourceW) / width, 0.000001, 1),
        height: clamp(Number(annotation.h || annotation.sourceH) / height, 0.000001, 1),
      });
      if (annotation.type === 'shape') {
        output.shape = annotation.shape || 'rectangle'; output.fillColor = annotation.fillColor || 'transparent';
      }
    }
    return output;
  }

  function aiVideoAnnotation(annotation, width, height) {
    var output = {
      id: annotation.id,
      type: annotation.type === 'rect' ? 'box' : annotation.type === 'note' ? 'note' : annotation.type === 'draw' ? 'freehand' : 'arrow',
      message: String(annotation.message || ''),
      color: annotation.color || '#ff5c49',
      time: { start: Number(annotation.start || 0), end: Number(annotation.end || annotation.start || 0) },
    };
    if (annotation.type === 'rect') {
      output.box = Object.assign(normalizedPoint(annotation.x, annotation.y, width, height), {
        width: clamp(Number(annotation.w) / width, 0.000001, 1), height: clamp(Number(annotation.h) / height, 0.000001, 1),
      });
    } else if (annotation.type === 'arrow') {
      output.from = normalizedPoint(annotation.x, annotation.y, width, height);
      output.to = normalizedPoint(annotation.x2, annotation.y2, width, height);
    } else if (annotation.type === 'note') output.point = normalizedPoint(annotation.x, annotation.y, width, height);
    else output.points = (annotation.points || []).map(function (point) { return normalizedPoint(point.x, point.y, width, height); });
    return output;
  }

  async function mediaDimensions(blob, kind) {
    if (kind === 'image') {
      if (typeof global.createImageBitmap === 'function') {
        var bitmap = await global.createImageBitmap(blob);
        var imageSize = { width: bitmap.width, height: bitmap.height };
        if (typeof bitmap.close === 'function') bitmap.close();
        return imageSize;
      }
      return new Promise(function (resolve, reject) {
        var image = new Image(); var url = URL.createObjectURL(blob);
        image.onload = function () { URL.revokeObjectURL(url); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
        image.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Image CyAnnota illisible.')); };
        image.src = url;
      });
    }
    return new Promise(function (resolve, reject) {
      var video = global.document.createElement('video'); var url = URL.createObjectURL(blob);
      video.preload = 'metadata';
      video.onloadedmetadata = function () {
        URL.revokeObjectURL(url);
        resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
      };
      video.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Vidéo CyAnnota illisible.')); };
      video.src = url;
    });
  }

  async function dataUrlBlob(dataUrl) {
    var response = await fetch(dataUrl);
    if (!response.ok) throw new Error('Source image CyAnnota illisible.');
    return response.blob();
  }

  function findZipEntry(zip, requestedPath) {
    var direct = requestedPath && zip.file(requestedPath);
    if (direct) return direct;
    var suffix = '/' + String(requestedPath || '').toLowerCase();
    var name = Object.keys(zip.files).find(function (candidate) {
      return !zip.files[candidate].dir && candidate.toLowerCase().endsWith(suffix);
    });
    return name ? zip.file(name) : null;
  }

  async function importWorkspaceAsAi(zip) {
    var workspaceEntry = findZipEntry(zip, 'workspace.cyannota.json');
    if (!workspaceEntry) throw new Error('workspace.cyannota.json est absent du projet.');
    var workspace = JSON.parse(await workspaceEntry.async('string'));
    if (!workspace || !Array.isArray(workspace.tabs) || workspace.tabs.length === 0) throw new Error('Espace de travail CyAnnota invalide.');
    var media = {};
    var tabs = [];
    for (var index = 0; index < workspace.tabs.length; index += 1) {
      var stored = workspace.tabs[index]; var project = stored.project || {};
      if (stored.kind === 'video' || project.kind === 'video') {
        var videoEntry = findZipEntry(zip, stored.sourcePath || project.sourcePath);
        if (!videoEntry) throw new Error('Vidéo interne introuvable pour « ' + stored.label + ' ».');
        var videoBlob = await videoEntry.async('blob');
        var videoSize = await mediaDimensions(videoBlob, project.videoType === 'image/gif' ? 'image' : 'video');
        media[stored.id] = videoBlob;
        tabs.push({
          id: stored.id, label: stored.label, kind: project.videoType === 'image/gif' ? 'gif' : 'video',
          mediaName: project.videoName, width: videoSize.width, height: videoSize.height,
          duration: Number(project.duration || videoSize.duration || 0), trimStart: project.trimStart, trimEnd: project.trimEnd,
          message: String(project.generalInstructions || ''),
          annotations: (project.annotations || []).map(function (annotation) { return aiVideoAnnotation(annotation, videoSize.width, videoSize.height); }),
        });
      } else {
        if (!project.image || typeof project.image.src !== 'string') throw new Error('Image interne introuvable pour « ' + stored.label + ' ».');
        var imageBlob = await dataUrlBlob(project.image.src);
        var imageSize = await mediaDimensions(imageBlob, 'image');
        media[stored.id] = imageBlob;
        tabs.push({
          id: stored.id, label: stored.label, kind: 'image', mediaName: project.image.name,
          width: imageSize.width, height: imageSize.height, message: String(project.globalInstructions || ''),
          annotations: (project.annotations || []).map(function (annotation) { return aiImageAnnotation(annotation, imageSize.width, imageSize.height); }),
        });
      }
    }
    var document = createDocument({
      title: tabs[0] && tabs[0].label || 'CyAnnota', locale: workspace.locale,
      workspaceMessage: workspace.workspaceInstructions, tabs: tabs,
    });
    requireValid(document);
    return { document: document, media: media, workspace: workspace };
  }

  async function readPackage(source, options) {
    if (!(source instanceof Blob)) throw new Error('Le fichier CyAnnota doit être un Blob ou un File.');
    var JSZipApi = zipApi(options || {});
    var zip = await JSZipApi.loadAsync(source);
    var aiEntry = zip.file('ai-source.cyannota.json');
    if (!aiEntry) return importWorkspaceAsAi(zip);
    var document = JSON.parse(await aiEntry.async('string'));
    requireValid(document);
    var media = {};
    for (var index = 0; index < document.tabs.length; index += 1) {
      var tab = document.tabs[index];
      var entry = tab.mediaPath && zip.file(tab.mediaPath);
      if (!entry) throw new Error('Média interne introuvable pour l’onglet « ' + tab.id + ' ».');
      media[tab.id] = await entry.async('blob');
    }
    return { document: document, media: media };
  }

  async function editPackage(source, operations, options) {
    options = options || {};
    if (!(source instanceof Blob)) throw new Error('Le fichier CyAnnota doit être un Blob ou un File.');
    var JSZipApi = zipApi(options);
    var zip = await JSZipApi.loadAsync(source);
    var aiEntry = zip.file('ai-source.cyannota.json');
    var imported;
    if (aiEntry) {
      var existingDocument = JSON.parse(await aiEntry.async('string'));
      requireValid(existingDocument);
      var existingWorkspaceEntry = findZipEntry(zip, 'workspace.cyannota.json');
      if (!existingWorkspaceEntry) throw new Error('workspace.cyannota.json est absent du projet.');
      var existingWorkspace = JSON.parse(await existingWorkspaceEntry.async('string'));
      var existingMedia = {};
      for (var mediaIndex = 0; mediaIndex < existingDocument.tabs.length; mediaIndex += 1) {
        var existingTab = existingDocument.tabs[mediaIndex];
        var existingMediaEntry = findZipEntry(zip, existingTab.mediaPath);
        if (!existingMediaEntry) throw new Error('Média interne introuvable pour l’onglet « ' + existingTab.id + ' ».');
        existingMedia[existingTab.id] = await existingMediaEntry.async('blob');
      }
      imported = { document: existingDocument, media: existingMedia, workspace: existingWorkspace };
    } else imported = await importWorkspaceAsAi(zip);
    var originalDocument = imported.document;
    var editedDocument = applyOperations(originalDocument, operations);
    var workspace = imported.workspace;
    var touchedByTab = new Map();
    operations.forEach(function (operation) {
      if (!operation.tabId || ['add-annotation', 'update-annotation', 'remove-annotation'].indexOf(operation.op) < 0) return;
      if (!touchedByTab.has(operation.tabId)) touchedByTab.set(operation.tabId, new Set());
      if (operation.annotationId) touchedByTab.get(operation.tabId).add(operation.annotationId);
      if (operation.annotation && operation.annotation.id) touchedByTab.get(operation.tabId).add(operation.annotation.id);
    });
    touchedByTab.forEach(function (ids, tabId) {
      var before = tabById(originalDocument, tabId);
      var after = tabById(editedDocument, tabId);
      after.annotations.forEach(function (annotation) {
        if (!before.annotations.some(function (candidate) { return candidate.id === annotation.id; })) ids.add(annotation.id);
      });
    });

    operations.forEach(function (operation) {
      if (operation.op === 'set-workspace-message') workspace.workspaceInstructions = String(operation.value || '');
      if (operation.op !== 'set-tab-message') return;
      var stored = workspace.tabs.find(function (tab) { return tab.id === operation.tabId; });
      if (!stored) return;
      if (stored.kind === 'video' || stored.project.kind === 'video') stored.project.generalInstructions = String(operation.value || '');
      else stored.project.globalInstructions = String(operation.value || '');
    });

    touchedByTab.forEach(function (ids, tabId) {
      var stored = workspace.tabs.find(function (tab) { return tab.id === tabId; });
      var aiTab = tabById(editedDocument, tabId);
      if (!stored) return;
      var internal = Array.isArray(stored.project.annotations) ? stored.project.annotations : [];
      ids.forEach(function (annotationId) {
        var nextAi = aiTab.annotations.find(function (annotation) { return annotation.id === annotationId; });
        var existingIndex = internal.findIndex(function (annotation) { return annotation.id === annotationId; });
        if (!nextAi) {
          if (existingIndex >= 0) internal.splice(existingIndex, 1);
          return;
        }
        var converted;
        if (stored.kind === 'video' || stored.project.kind === 'video') converted = videoAnnotation(nextAi, aiTab);
        else {
          var defaultLayerId = stored.project.layers && stored.project.layers[0] && stored.project.layers[0].id || 'ai-corrections';
          converted = imageAnnotation(nextAi, aiTab, defaultLayerId);
        }
        if (existingIndex >= 0) internal[existingIndex] = converted;
        else internal.push(converted);
      });
      stored.project.annotations = internal;
    });

    for (var index = 0; index < editedDocument.tabs.length; index += 1) {
      var aiTab = editedDocument.tabs[index];
      var mediaBlob = mediaFor(options.media || {}, aiTab.id) || imported.media[aiTab.id];
      if (!(mediaBlob instanceof Blob)) throw new Error('Média manquant pour l’onglet « ' + aiTab.id + ' ».');
      if (!aiTab.mediaPath) {
        aiTab.mediaPath = 'tabs/ai-source-' + safeName(aiTab.id) + '/media/source.' + extension(aiTab.mediaName, mediaBlob.type);
      }
      if (!zip.file(aiTab.mediaPath)) zip.file(aiTab.mediaPath, mediaBlob);
    }

    var workspaceEntry = findZipEntry(zip, 'workspace.cyannota.json');
    zip.file(workspaceEntry.name, JSON.stringify(workspace, null, 2));
    zip.file('ai-source.cyannota.json', JSON.stringify(editedDocument, null, 2));
    var manifestEntry = findZipEntry(zip, 'manifest.cyannota.json');
    var manifest = manifestEntry ? JSON.parse(await manifestEntry.async('string')) : {};
    var correctionCount = workspace.tabs.reduce(function (sum, tab) {
      var project = tab.project || {};
      var main = Array.isArray(project.annotations) ? project.annotations.length : 0;
      var stops = Array.isArray(project.frameStops) ? project.frameStops.reduce(function (stopSum, stop) {
        return stopSum + (Array.isArray(stop.annotations) ? stop.annotations.length : 0);
      }, 0) : 0;
      return sum + main + stops;
    }, 0);
    manifest = Object.assign({}, manifest, {
      format: 'cyannota-project', formatVersion: 1, title: editedDocument.title,
      updatedAt: new Date().toISOString(), workspace: workspaceEntry.name,
      tabCount: workspace.tabs.length,
      imageCount: workspace.tabs.filter(function (tab) { return tab.kind !== 'video' && tab.project.kind !== 'video'; }).length,
      videoCount: workspace.tabs.filter(function (tab) { return tab.kind === 'video' || tab.project.kind === 'video'; }).length,
      correctionCount: correctionCount, sourceApplication: 'CyAnnotaAI', aiSource: 'ai-source.cyannota.json',
    });
    zip.file(manifestEntry ? manifestEntry.name : 'manifest.cyannota.json', JSON.stringify(manifest, null, 2));
    var thumbnailEntry = manifest.thumbnail && findZipEntry(zip, manifest.thumbnail);
    var thumbnail = thumbnailEntry ? await thumbnailEntry.async('blob') : null;
    var archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    archive = new Blob([archive], { type: 'application/x-cyannota' });
    return {
      archive: archive, archiveName: safeName(editedDocument.title) + '.cyannota', document: editedDocument,
      workspace: workspace, manifest: manifest, thumbnail: thumbnail,
      summary: {
        title: editedDocument.title, tabCount: manifest.tabCount, imageCount: manifest.imageCount,
        videoCount: manifest.videoCount, annotationCount: correctionCount,
      },
    };
  }

  global.CyAnnotaAI = Object.freeze({
    format: FORMAT,
    version: VERSION,
    createDocument: createDocument,
    validateDocument: validateDocument,
    applyOperations: applyOperations,
    compileWorkspace: compileWorkspace,
    createPackage: createPackage,
    readPackage: readPackage,
    editPackage: editPackage,
  });
})(window);
