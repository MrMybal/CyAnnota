# CyAnnota

<p align="center"><img src="public/cyannota-logo.png" alt="Logo CyAnnota" width="160" /></p>

CyAnnota est un outil local d’annotation d’images et de vidéos. Il permet de préparer des retours visuels, de collaborer en équipe, de créer des arrêts sur image et d’exporter les annotations pour une personne ou une IA dans des projets réouvrables au format `.cyannota`.

> **Bêta :** CyAnnota est encore en développement. Certaines fonctionnalités peuvent évoluer ou contenir des bugs.

## Aperçus

### Accueil et import des médias

![Accueil de CyAnnota avec import d’image ou de vidéo](docs/screenshots/01-home.png)

### Annotation d’une image

![Annotation d’une image avec cadres, flèches, notes et déplacements](docs/screenshots/02-image-annotations.png)

### Annotation vidéo et timeline

![Annotation d’une vidéo avec corrections temporelles et timeline](docs/screenshots/03-video-timeline.png)

## Fonctions principales

- annotations d’images avec cadres, formes, textes, couleurs, suppressions et découpes ;
- annotations vidéo temporelles et arrêts sur image précis ;
- zoom et déplacement dans un espace de travail de type canvas ;
- sauvegarde de plusieurs médias dans un projet `.cyannota` ;
- exports Humain sans prompt et exports IA avec prompts structurés ;
- intégration locale avec CyTask, CyCapture et des applications Web ;
- application Web locale et application Windows Electron ;
- interface et prompts en anglais ou en français, avec l’anglais par défaut.

## Développement

Prérequis : Node.js 22.13 ou plus récent.

```bash
npm install
npm run dev
```

Build Web :

```bash
npm run build
```

Build Windows portable et installeur :

```bash
npm run desktop:build
```

Le contrat d’intégration est décrit dans [`integrations/README.md`](integrations/README.md).

## Licence

Copyright (C) 2026 CyberAlien.

CyAnnota est distribué sous **GNU Affero General Public License v3.0 uniquement** (`AGPL-3.0-only`). Consultez [`LICENSE`](LICENSE).

Le SDK autonome [`public/cyannota-integration.js`](public/cyannota-integration.js) est distribué séparément sous licence MIT afin de permettre son intégration dans d’autres logiciels et sites.

Les composants tiers conservent leurs propres licences. Consultez [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), notamment pour FFmpeg et `@ffmpeg/core`.
