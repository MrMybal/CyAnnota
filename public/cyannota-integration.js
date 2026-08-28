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
  var PROTOCOL_VERSION = 1;

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
    if (explicitKind === 'image' || explicitKind === 'video') return explicitKind;
    if (file.type && file.type.indexOf('video/') === 0) return 'video';
    if (file.type && file.type.indexOf('image/') === 0) return 'image';
    throw new Error('mediaKind doit être « image » ou « video » lorsque le MIME est absent.');
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

    var popup = global.open(
      editorUrl.toString(),
      options.windowName || 'cyannota-' + attachmentId,
      options.windowFeatures || 'popup,width=1600,height=1000,resizable=yes,scrollbars=yes',
    );
    if (!popup) throw new Error('La fenêtre CyAnnota a été bloquée par le navigateur.');

    var closed = false;
    var readyResolve;
    var readyReject;
    var ready = new Promise(function (resolve, reject) {
      readyResolve = resolve;
      readyReject = reject;
    });

    function replyToSave(message, result, error) {
      popup.postMessage({
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

    function receive(event) {
      if (event.source !== popup || event.origin !== editorUrl.origin || !event.data) return;
      var message = event.data;
      if (message.source !== 'cyannota' || message.session !== session) return;

      if (message.type === 'ready' && message.protocol === PROTOCOL) {
        popup.postMessage({
          source: providerId,
          type: 'open-media',
          protocol: PROTOCOL,
          protocolVersion: PROTOCOL_VERSION,
          session: session,
          attachmentId: attachmentId,
          title: options.title || options.file.name || (mediaKind(options.file, options.mediaKind) === 'video' ? 'video.mp4' : 'image.png'),
          mediaKind: mediaKind(options.file, options.mediaKind),
          file: options.file,
          document: options.document,
          readOnly: options.readOnly === true,
          maximumDocumentBytes: options.maximumDocumentBytes,
          exportAudience: options.exportAudience === 'human' ? 'human' : 'ai',
          exportContainer: options.exportContainer === 'project' ? 'project' : 'zip',
          includeOriginalVideos: options.includeOriginalVideos === true,
        }, editorUrl.origin);
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
      }
    }

    global.addEventListener('message', receive);
    var closeWatcher = global.setInterval(function () {
      if (!popup.closed) return;
      global.clearInterval(closeWatcher);
      if (!closed) readyReject(new Error('La fenêtre CyAnnota a été fermée avant son initialisation.'));
      handle.close(false);
    }, 500);

    var handle = {
      session: session,
      popup: popup,
      ready: ready,
      close: function close(closePopup) {
        if (closed) return;
        closed = true;
        global.clearInterval(closeWatcher);
        global.removeEventListener('message', receive);
        if (closePopup !== false && !popup.closed) popup.close();
      },
    };
    return handle;
  }

  global.CyAnnotaIntegration = Object.freeze({
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    open: open,
  });
})(window);
