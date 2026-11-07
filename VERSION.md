# CyAnnota 0.4.4 — Beta

[English](VERSION.md) · [Français](VERSION.fr.md) · [README](README.md) · [Windows release](https://github.com/MrMybal/CyAnnota/releases/tag/v0.4.4)

CyAnnota remains in **beta**, undergoing validation before a stable release. Both the published Windows application and the online edition display version **0.4.4**, but the online edition is built from the repository and can include changes made after the Windows release.

## Published Windows build

The [0.4.4 release](https://github.com/MrMybal/CyAnnota/releases/tag/v0.4.4) provides a Windows x64 installer, a portable executable and `SHA256SUMS.txt`.

- Added local model import and conversion to GLB, with approximate mesh paint annotations and saved camera references.
- Added multi-stroke, multi-view paint sessions with validation, cancellation and erasing.
- Improved 3D navigation, Textured/Solid/Wireframe display, annotation visibility, transparency and default colors per action.
- Expanded embedded integrations with Send/Close actions, archive/direct results, thumbnails and package-reading helpers.
- Added structured AI authoring helpers and imports alongside existing media in CyAI workspace sessions.
- Added direct ZIP clipboard export alongside normal file saving.

## Online edition and current source

The [online application](https://mrmybal.github.io/CyAnnota/) is hosted on GitHub Pages. The separate static build preserves the local Web and Windows build targets. Matching source code is available as [source.zip](https://mrmybal.github.io/CyAnnota/source.zip).

The [Web deployment change](https://github.com/MrMybal/CyAnnota/commit/7b323ae9eb45a45df3b03f07b76db96e0c7cd057) also fixes the default destination preparation for Save and ordinary exports and adjusts asset paths for hosting under `/CyAnnota/`. These changes were made after the Windows 0.4.4 binaries were published; they are not a rebuilt Windows release.

## Known limitations

- Published native packages are Windows x64. No macOS or Linux application packages accompany release 0.4.4.
- Browser clipboard operations depend on the browser's supported formats and permissions. Downloading the project or ZIP is the fallback when archive copying is unavailable.
- Video decoding depends on the file's codecs and browser support. Local conversion can take time and use substantial memory; no fixed performance or file-size guarantee is provided.
- `.blend` files are not converted inside CyAnnota. Export them as GLB from Blender first.
- Model compatibility depends on the selected format and its resources. Include companion files for glTF or models with external textures; a self-contained GLB is easier to transfer. OBJ import does not load a separate MTL material definition.
- Mesh paint is approximate guidance. Delete, recolor and separate actions annotate a request; they do not change the model geometry or materials.
- Human exports contain annotation text and project data without prompt files. Use Save to retain source media; delivery exports may optimize images or omit original videos.

## Reported issues

The release notes do not publish a bug-by-bug list. Consult the [issue tracker](https://github.com/MrMybal/CyAnnota/issues) for reports and [release history](https://github.com/MrMybal/CyAnnota/releases) for published changes.

When reporting a problem, include the CyAnnota version, Web or Windows edition, browser if relevant, media format, steps to reproduce and the displayed error. Share a small public test file when possible.
