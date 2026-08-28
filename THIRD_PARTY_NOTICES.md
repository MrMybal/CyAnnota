# Notices des composants tiers

CyAnnota inclut ou utilise les composants tiers ci-dessous. Ces composants ne sont pas couverts par le copyright de CyAnnota et restent soumis à leurs licences respectives.

## Traitement vidéo

### @ffmpeg/core 0.12.10

- Licence déclarée par le paquet distribué : `GPL-2.0-or-later`.
- Projet et code source correspondant : <https://github.com/ffmpegwasm/ffmpeg.wasm>
- Texte de la GPL v2 : [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt)

Le cœur WebAssembly contient du code dérivé de FFmpeg. FFmpeg est généralement sous LGPL-2.1-or-later, mais certains composants et configurations relèvent de la GPL. La distribution CyAnnota respecte donc la licence GPL déclarée par la version exacte de `@ffmpeg/core` installée.

### @ffmpeg/ffmpeg 0.12.15

- Licence : MIT.
- Projet : <https://github.com/ffmpegwasm/ffmpeg.wasm>

## Interface et archives

- React 19.2.6 et React DOM 19.2.6 — MIT — <https://react.dev/>
- Next.js 16.2.6 — MIT — <https://nextjs.org/>
- JSZip 3.10.1 — utilisé selon l’option MIT de sa double licence MIT ou GPL-3.0-or-later — <https://stuk.github.io/jszip/>
- Electron 44.0.0 — MIT — <https://www.electronjs.org/>

Le runtime Electron incorpore Chromium et d’autres composants. Les distributions Electron générées conservent les fichiers de licences et notices Chromium livrés avec Electron.

Le texte standard de la licence MIT est disponible dans [`licenses/MIT.txt`](licenses/MIT.txt). Les mentions de copyright propres à chaque composant sont disponibles dans leurs distributions et dépôts sources respectifs.
