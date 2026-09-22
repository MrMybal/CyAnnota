/*
 * CyAnnota Integration SDK
 * Copyright (c) 2026 CyberAlien
 * SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(function exposeCyAnnotaIntegration(global) {
  'use strict';

  var PROTOCOL = 'cyannota.integration';
  var PROTOCOL_VERSION = 2;

  function sessionId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'cyannota-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function assertProviderId(value) {
    var providerId = String(value || '').toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(providerId)) {
      throw new Error('integrationId doit contenir 2 à 40 lettres, chiffres, points, tirets ou underscores.');
    }
    return providerId;
  }

  function mediaKind(file, explicitKind) {
    if (explicitKind === 'image' || explicitKind === 'video' || explicitKind === 'project') return explicitKind;
    var fileName = String(file.name || '').toLowerCase();
    if (/\.(?:cyannota|cyannota\.zip|zip)$/.test(fileName) || file.type === 'application/x-cyannota') return 'project';
    if (file.type && file.type.indexOf('video/') === 0) return 'video';
    if (file.type && file.type.indexOf('image/') === 0) return 'image';
    throw new Error('mediaKind doit être « image », « video » ou « project » lorsque le MIME est absent.');
  }

  function open(options) {
    options = options || {};
    if (!(options.file instanceof Blob)) throw new Error('file doit être un Blob ou un File.');
    if (!global.location || !/^https?:$/.test(global.location.protocol)) {
      throw new Error('Le pont Web CyAnnota doit être ouvert depuis une origine HTTP(S).');
    }

    var providerId = assertProviderId(options.integrationId);
    var session = options.session || sessionId();
    var attachmentId = String(options.attachmentId || options.mediaId || session);
    var editorUrl = new URL(options.cyAnnotaUrl || 'http://localhost:3000/');
    editorUrl.searchParams.set('integration', providerId);
    editorUrl.searchParams.set('integrationName', String(options.integrationName || providerId));
    editorUrl.searchParams.set('session', session);
    editorUrl.searchParams.set('attachmentId', attachmentId);
    editorUrl.searchParams.set('parentOrigin', global.location.origin);
    var embedded = Boolean(options.container);
    editorUrl.searchParams.set('display', embedded ? 'iframe' : 'popup');

    var popup = null;
    var frame = null;
    var editorWindow = null;
    if (embedded) {
      if (!options.container || typeof options.container.appendChild !== 'function') {
        throw new Error('container doit être un élément DOM valide.');
      }
      frame = global.document.createElement('iframe');
      frame.className = options.iframeClassName || 'cyannota-integrated-editor';
      frame.title = options.iframeTitle || 'CyAnnota';
      frame.src = editorUrl.toString();
      frame.allow = 'clipboard-read; clipboard-write; fullscreen';
      frame.style.width = '100%';
      frame.style.height = options.height || 'min(1000px, 85vh)';
      frame.style.border = '0';
      options.container.replaceChildren(frame);
      editorWindow = frame.contentWindow;
    } else {
      popup = global.open(
        editorUrl.toString(),
        options.windowName || 'cyannota-' + attachmentId,
        options.windowFeatures || 'popup,width=1600,height=1000,resizable=yes,scrollbars=yes',
      );
      if (!popup) throw new Error('La fenêtre CyAnnota a été bloquée par le navigateur.');
      editorWindow = popup;
    }
    if (!editorWindow) throw new Error('La vue CyAnnota n’a pas pu être créée.');

    var closed = false;
    var readySettled = false;
    var readyResolve;
    var readyReject;
    var ready = new Promise(function (resolve, reject) {
      readyResolve = resolve;
      readyReject = reject;
    });

    function replyToSave(message, result, error) {
      editorWindow.postMessage({
        source: providerId,
        type: 'save-result',
        protocol: PROTOCOL,
        protocolVersion: PROTOCOL_VERSION,
        session: session,
        ok: !error,
        revision: result && typeof result.revision === 'number' ? result.revision : undefined,
        error: error ? (error.message || String(error)) : undefined,
      }, editorUrl.origin);
    }

    function replyToSend(result, error) {
      editorWindow.postMessage({
        source: providerId,
        type: 'send-result-ack',
        protocol: PROTOCOL,
        protocolVersion: PROTOCOL_VERSION,
        session: session,
        ok: !error,
        revision: result && typeof result.revision === 'number' ? result.revision : undefined,
        error: error ? (error.message || String(error)) : undefined,
      }, editorUrl.origin);
      if (!error && options.closeOnSend !== false) {
        if (typeof options.onClose === 'function') {
          options.onClose({ attachmentId: attachmentId, reason: 'sent' });
        }
        global.setTimeout(function () { handle.close(); }, 0);
      }
    }

    function receive(event) {
      if (event.source !== editorWindow || event.origin !== editorUrl.origin || !event.data) return;
      var message = event.data;
      if (message.source !== 'cyannota' || message.session !== session) return;

      if (message.type === 'ready' && message.protocol === PROTOCOL) {
        editorWindow.postMessage({
          source: providerId,
          type: 'open-media',
          protocol: PROTOCOL,
          protocolVersion: PROTOCOL_VERSION,
          session: session,
          attachmentId: attachmentId,
          title: options.title || options.file.name || (mediaKind(options.file, options.mediaKind) === 'video' ? 'video.mp4' : mediaKind(options.file, options.mediaKind) === 'project' ? 'project.cyannota' : 'image.png'),
          mediaKind: mediaKind(options.file, options.mediaKind),
          file: options.file,
          document: options.document,
          readOnly: options.readOnly === true,
          maximumDocumentBytes: options.maximumDocumentBytes,
          exportAudience: options.exportAudience === 'human' ? 'human' : 'ai',
          exportContainer: options.exportContainer === 'project' ? 'project' : 'zip',
          includeOriginalVideos: options.includeOriginalVideos === true,
          resultMode: options.resultMode === 'direct' || options.resultMode === 'both' ? options.resultMode : 'archive',
          closeOnSend: options.closeOnSend !== false,
          maximumResultBytes: options.maximumResultBytes,
          locale: options.locale === 'fr' ? 'fr' : 'en',
        }, editorUrl.origin);
        readySettled = true;
        readyResolve({ session: session, capabilities: message.capabilities || {} });
        if (typeof options.onReady === 'function') options.onReady(message.capabilities || {});
        return;
      }

      if (message.type === 'save-annotations' && message.attachmentId === attachmentId) {
        if (typeof options.onSave !== 'function') {
          replyToSave(message, null, new Error('L’application hôte n’a fourni aucun gestionnaire onSave.'));
          return;
        }
        Promise.resolve(
          options.onSave({
            attachmentId: attachmentId,
            document: message.document,
            exportPreferences: message.exportPreferences || {},
          }),
        ).then(
          function (result) { replyToSave(message, result || {}, null); },
          function (error) { replyToSave(message, null, error); },
        );
        return;
      }

      if (message.type === 'send-result' && message.attachmentId === attachmentId) {
        var sendHandler = typeof options.onSend === 'function' ? options.onSend : options.onSave;
        if (typeof sendHandler !== 'function') {
          replyToSend(null, new Error('L’application hôte n’a fourni aucun gestionnaire onSend.'));
          return;
        }
        Promise.resolve(sendHandler({
          attachmentId: attachmentId,
          archiveName: message.archiveName,
          archive: message.archive,
          files: Array.isArray(message.files) ? message.files : undefined,
          document: message.document,
          manifest: message.manifest,
          thumbnail: message.thumbnail,
          summary: message.summary,
          exportPreferences: message.exportPreferences || {},
        })).then(
          function (result) { replyToSend(result || {}, null); },
          function (error) { replyToSend(null, error); },
        );
        return;
      }

      if (message.type === 'integration-closed' && message.attachmentId === attachmentId) {
        if (typeof options.onClose === 'function') {
          options.onClose({ attachmentId: attachmentId, reason: message.reason || 'cancel' });
        }
        handle.close();
      }
    }

    global.addEventListener('message', receive);
    var closeWatcher = global.setInterval(function () {
      var viewClosed = popup ? popup.closed : !frame || !frame.isConnected;
      if (!viewClosed) return;
      global.clearInterval(closeWatcher);
      if (!closed && !readySettled) readyReject(new Error('La fenêtre CyAnnota a été fermée avant son initialisation.'));
      if (!closed && typeof options.onClose === 'function') {
        options.onClose({ attachmentId: attachmentId, reason: 'window' });
      }
      handle.close(false);
    }, 500);

    var handle = {
      session: session,
      popup: popup,
      iframe: frame,
      ready: ready,
      close: function close(closePopup) {
        if (closed) return;
        closed = true;
        global.clearInterval(closeWatcher);
        global.removeEventListener('message', receive);
        if (closePopup !== false && popup && !popup.closed) popup.close();
        if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
      },
    };
    return handle;
  }

  function summarizeDocument(document) {
    var tabs = Array.isArray(document && document.tabs)
      ? document.tabs
      : document
        ? [{ kind: document.kind === 'video' ? 'video' : 'image', project: document }]
        : [];
    var imageCount = 0;
    var videoCount = 0;
    var annotationCount = 0;
    tabs.forEach(function (tab) {
      var project = tab && tab.project ? tab.project : tab;
      var kind = tab && tab.kind === 'video' || project && project.kind === 'video' ? 'video' : 'image';
      if (kind === 'video') videoCount += 1;
      else imageCount += 1;
      annotationCount += Array.isArray(project && project.annotations) ? project.annotations.length : 0;
      if (kind === 'video' && Array.isArray(project && project.frameStops)) {
        project.frameStops.forEach(function (stop) {
          annotationCount += Array.isArray(stop && stop.annotations) ? stop.annotations.length : 0;
        });
      }
    });
    var first = tabs[0] && (tabs[0].project || tabs[0]);
    return {
      title: String(document && document.title || first && first.title || 'CyAnnota'),
      tabCount: tabs.length,
      imageCount: imageCount,
      videoCount: videoCount,
      annotationCount: annotationCount,
    };
  }

  async function readDocument(source) {
    var document = source;
    if (source instanceof Blob) document = JSON.parse(await source.text());
    else if (typeof source === 'string') document = JSON.parse(source);
    if (!document || typeof document !== 'object') throw new Error('Document CyAnnota invalide.');
    return { document: document, summary: summarizeDocument(document) };
  }

  function zipEntry(zip, requestedPath) {
    var exact = zip.file(requestedPath);
    if (exact) return exact;
    var suffix = '/' + requestedPath.toLowerCase();
    var name = Object.keys(zip.files).find(function (candidate) {
      return candidate.toLowerCase() === requestedPath.toLowerCase() || candidate.toLowerCase().endsWith(suffix);
    });
    return name ? zip.file(name) : null;
  }

  async function readPackage(source, options) {
    options = options || {};
    if (!(source instanceof Blob)) throw new Error('Le paquet CyAnnota doit être un Blob ou un File.');
    var JSZipApi = options.JSZip || global.JSZip;
    if (JSZipApi && JSZipApi.default) JSZipApi = JSZipApi.default;
    if (!JSZipApi || typeof JSZipApi.loadAsync !== 'function') {
      throw new Error('JSZip est requis pour lire un fichier .cyannota. Passez { JSZip } à readPackage.');
    }
    var zip = await JSZipApi.loadAsync(source);
    var manifestEntry = zipEntry(zip, 'manifest.cyannota.json');
    if (!manifestEntry) throw new Error('manifest.cyannota.json est absent du paquet CyAnnota.');
    var manifest = JSON.parse(await manifestEntry.async('string'));
    if (!manifest || manifest.format !== 'cyannota-project' || manifest.formatVersion !== 1) {
      throw new Error('Version de paquet CyAnnota non prise en charge.');
    }
    var workspaceEntry = zipEntry(zip, manifest.workspace || 'workspace.cyannota.json');
    var workspace = workspaceEntry ? JSON.parse(await workspaceEntry.async('string')) : null;
    var thumbnailEntry = zipEntry(zip, manifest.thumbnail || 'thumbnail.png');
    var thumbnail = thumbnailEntry ? await thumbnailEntry.async('blob') : null;
    var fileNames = Object.keys(zip.files).filter(function (name) { return !zip.files[name].dir; });
    var summary = {
      title: String(manifest.title || 'CyAnnota'),
      tabCount: Number(manifest.tabCount || 0),
      imageCount: Number(manifest.imageCount || 0),
      videoCount: Number(manifest.videoCount || 0),
      annotationCount: Number(manifest.correctionCount || 0),
    };
    return {
      manifest: manifest,
      workspace: workspace,
      thumbnail: thumbnail,
      summary: summary,
      files: fileNames,
      readFile: async function (filePath, outputType) {
        var entry = zipEntry(zip, filePath);
        if (!entry) throw new Error('Fichier introuvable dans le paquet : ' + filePath);
        return entry.async(outputType || 'blob');
      },
    };
  }

  function archiveFile(result) {
    if (!result || !(result.archive instanceof Blob)) {
      throw new Error('Ce résultat CyAnnota ne contient pas d’archive.');
    }
    var name = String(result.archiveName || 'annotations.cyannota');
    return new File([result.archive], name, {
      type: result.archive.type || (name.endsWith('.zip') ? 'application/zip' : 'application/x-cyannota'),
      lastModified: Date.now(),
    });
  }

  function mountPreview(container, preview, options) {
    options = options || {};
    if (!container || typeof container.replaceChildren !== 'function') {
      throw new Error('Le conteneur de miniature est invalide.');
    }
    var summary = preview && (preview.summary || preview.manifest) || {};
    var card = global.document.createElement('article');
    card.className = options.className || 'cyannota-miniature';
    Object.assign(card.style, {
      display: 'grid', gridTemplateColumns: '112px minmax(0, 1fr)', gap: '12px',
      alignItems: 'center', minHeight: '76px', padding: '10px', border: '1px solid #343430',
      borderRadius: '10px', background: '#181916', color: '#f1eee8', fontFamily: 'system-ui, sans-serif',
    });
    var thumbnailUrl = null;
    if (preview && preview.thumbnail instanceof Blob) {
      var image = global.document.createElement('img');
      thumbnailUrl = URL.createObjectURL(preview.thumbnail);
      image.src = thumbnailUrl;
      image.alt = '';
      Object.assign(image.style, { width: '112px', height: '63px', objectFit: 'cover', borderRadius: '6px', background: '#0d0e0c' });
      card.appendChild(image);
    }
    var body = global.document.createElement('div');
    var title = global.document.createElement('strong');
    title.textContent = String(summary.title || 'CyAnnota');
    title.style.display = 'block';
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.whiteSpace = 'nowrap';
    var counts = global.document.createElement('span');
    counts.textContent = Number(summary.tabCount || 0) + ' tab(s) · ' + Number(summary.annotationCount || summary.correctionCount || 0) + ' annotation(s)';
    Object.assign(counts.style, { display: 'block', marginTop: '5px', color: '#aaa69e', fontSize: '12px' });
    body.appendChild(title);
    body.appendChild(counts);
    card.appendChild(body);
    container.replaceChildren(card);
    return function unmountPreview() {
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      if (card.parentNode === container) container.removeChild(card);
    };
  }

  global.CyAnnotaIntegration = Object.freeze({
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    open: open,
    readDocument: readDocument,
    readPackage: readPackage,
    summarizeDocument: summarizeDocument,
    archiveFile: archiveFile,
    mountPreview: mountPreview,
  });
})(window);
