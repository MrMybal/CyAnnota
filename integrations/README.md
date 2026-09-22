# Intégrer CyAnnota

CyAnnota expose un contrat local unique pour CyCapture, CyTask, CyAIOrchestrator et les sites Web. L’éditeur peut être ouvert dans une fenêtre ou directement intégré dans une iframe. À la fin, le bouton **Envoyer** remet le résultat à l’application hôte ; **Fermer** quitte l’éditeur sans transmettre de résultat.

Pour permettre à une IA visuelle de créer ou modifier directement des annotations spatiales et temporelles, consulter [`AI_AUTHORING.md`](AI_AUTHORING.md) et le schéma [`cyannota-ai.schema.json`](cyannota-ai.schema.json).

## Formats

- `.cyannota` : projet CyAnnota reconnu par Windows et par les logiciels partenaires. C’est un conteneur ZIP portant une extension dédiée.
- `.cyannota.zip` : archive compatible avec le flux historique et les outils ZIP.
- `manifest.cyannota.json` : métadonnées légères (`title`, compteurs, type d’audience et chemin de miniature).
- `thumbnail.png` : aperçu 640 × 360 lisible par CyTask sans charger les médias complets.
- `workspace.cyannota.json` : état modifiable des onglets.

Une sauvegarde `.cyannota` inclut les sources. Un export peut omettre les vidéos originales. En mode `human`, aucun `prompt.md` n’est écrit. En mode `ai`, les prompts structurés sont inclus.

## Intégration Web ou Electron

Servir le SDK `public/cyannota-integration.js`, puis l’appeler depuis un clic utilisateur afin d’éviter le blocage des popups :

```html
<script src="http://localhost:3000/cyannota-integration.js"></script>
<script>
  async function annotateCapture(file, existingDocument) {
    const container = document.querySelector('#cyannota-editor');
    const editor = CyAnnotaIntegration.open({
      cyAnnotaUrl: 'http://localhost:3000/',
      integrationId: 'cycapture',
      integrationName: 'CyCapture',
      attachmentId: crypto.randomUUID(),
      container,
      file,
      document: existingDocument,
      exportAudience: 'human',
      exportContainer: 'project',
      includeOriginalVideos: false,
      resultMode: 'both',
      closeOnSend: true,
      locale: 'fr',
      async onSend(result) {
        // Archive prête à joindre à la conversation.
        if (result.archive) {
          await conversation.attach(CyAnnotaIntegration.archiveFile(result));
        }

        // Les mêmes éléments sont également accessibles sans relire le ZIP.
        await saveDirectFiles(result.attachmentId, result.files, result.document);
        return { revision: 1 };
      },
      onClose() {
        closeEditorPanel();
      },
    });
    await editor.ready;
  }
</script>
```

Le protocole courant est `cyannota.integration`, version `2`. La version 1 reste acceptée pour les intégrations existantes. Le transfert du résultat se produit uniquement après le clic sur **Envoyer** et revient à la fenêtre ou à l’iframe ayant créé la session.

`resultMode` contrôle le résultat :

- `archive` : transmet uniquement le fichier `.cyannota` ou `.cyannota.zip` prêt à joindre ;
- `direct` : transmet les fichiers sous forme de `{ path, type, size, blob }`, sans recréer ni relire un ZIP ;
- `both` : transmet les deux représentations.

Le résultat contient également `document`, `manifest`, `summary` et `thumbnail`. L’hôte peut fixer `maximumResultBytes`, choisir les réglages initiaux d’export et récupérer leur valeur finale dans `exportPreferences`. `locale` accepte `en` ou `fr` et vaut `en` par défaut.

Pour CyTask, utiliser `integrationId: 'cytask'`. Le mode `direct` permet de stocker séparément le document et les médias remis par CyAnnota ; le mode `archive` conserve un fichier autonome ouvrable dans CyAnnota. CyTask reste libre de choisir la représentation adaptée à son stockage.

## Ouvrir directement un projet CyAnnota

Un fichier `.cyannota` peut être remis directement à l’éditeur intégré :

```js
CyAnnotaIntegration.open({
  cyAnnotaUrl: 'http://localhost:3000/',
  integrationId: 'cyaiorchestrator',
  integrationName: 'CyAIOrchestrator',
  attachmentId: messageAttachment.id,
  container: document.querySelector('#annotation-panel'),
  file: cyannotaFile,
  mediaKind: 'project',
  resultMode: 'archive',
  onSend: (result) => conversation.attach(CyAnnotaIntegration.archiveFile(result)),
});
```

## Lecture directe et mode miniature

Une application peut lire le manifeste, la miniature, l’espace de travail ou un fichier interne sans gérer elle-même la structure du ZIP. Avec un bundler, transmettre simplement son import `JSZip` :

```js
import JSZip from 'jszip';

const preview = await CyAnnotaIntegration.readPackage(cyannotaFile, { JSZip });
const removePreview = CyAnnotaIntegration.mountPreview(
  document.querySelector('#attachment-preview'),
  preview,
);

console.log(preview.summary.tabCount);
console.log(preview.summary.annotationCount);

const workspace = preview.workspace;
const firstAnnotatedPath = preview.files.find((path) =>
  /(?:tabs|onglets)\/[^/]+\/images\/annotated\.(?:webp|png|jpe?g)$/i.test(path),
);
const firstAnnotatedImage = await preview.readFile(
  firstAnnotatedPath,
  'blob',
);
```

`mountPreview` affiche la première image disponible, le nombre d’onglets et le nombre total d’annotations. Le résultat de `onSend` peut être passé directement à cette méthode, sans rouvrir l’archive. Pour un document JSON non compressé, utiliser `readDocument` ou `summarizeDocument`.

## Intégration desktop

L’installeur Windows associe `.cyannota` à CyAnnota. Une application locale peut aussi ouvrir directement un projet ou un média :

```text
CyAnnota.exe "D:\captures\interface.png"
CyAnnota.exe "D:\taches\correction.cyannota"
```

Le lien local suivant est aussi reconnu par l’application installée :

```text
cyannota://open?path=D%3A%5Ccaptures%5Cinterface.mp4
```

Pour CyCapture desktop, la méthode la plus simple et la plus fiable consiste à lancer `CyAnnota.exe` avec le chemin de la capture. Pour CyTask desktop, ouvrir le fichier `.cyannota` associé à la tâche ; le manifeste et `thumbnail.png` permettent d’afficher la fiche avant l’ouverture de l’éditeur.

## Évolution du stockage

Le format comporte des numéros séparés (`formatVersion` pour le conteneur, `workspaceVersion` pour l’espace de travail). Une intégration doit ignorer les propriétés inconnues et refuser uniquement une version majeure qu’elle ne sait pas lire. Les médias restent référencés par leurs chemins internes, ce qui permettra ultérieurement un stockage partagé ou adressé par contenu sans casser les projets existants.

## Licence du SDK

Le SDK autonome `public/cyannota-integration.js` est distribué sous licence MIT. L’application CyAnnota reste distribuée sous `AGPL-3.0-only`.
