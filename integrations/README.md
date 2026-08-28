# Intégrer CyAnnota

CyAnnota expose un contrat local unique pour CyCapture, CyTask et les sites Web. Le média reste chez l’utilisateur : il est transmis à CyAnnota, annoté localement, puis seul le document d’annotations est rendu à l’application hôte.

## Formats

- `.cyannota` : projet CyAnnota reconnu par Windows et par les logiciels partenaires. C’est un conteneur ZIP portant une extension dédiée.
- `.cyannota.zip` : archive compatible avec le flux historique et les outils ZIP.
- `manifest.cyannota.json` : métadonnées légères (`title`, compteurs, type d’audience et chemin de miniature).
- `thumbnail.png` : aperçu 640 × 360 lisible par CyTask sans charger les médias complets.
- `workspace.cyannota.json` : état modifiable des onglets.

Une sauvegarde `.cyannota` inclut les sources. Un export peut omettre les vidéos originales. En mode `human`, aucun `prompt.md` n’est écrit. En mode `ai`, les prompts structurés sont inclus.

## Intégration Web, CyTask ou CyCapture Web

Servir le SDK `public/cyannota-integration.js`, puis l’appeler depuis un clic utilisateur afin d’éviter le blocage des popups :

```html
<script src="http://localhost:3000/cyannota-integration.js"></script>
<script>
  async function annotateCapture(file, existingDocument) {
    const editor = CyAnnotaIntegration.open({
      cyAnnotaUrl: 'http://localhost:3000/',
      integrationId: 'cycapture',
      integrationName: 'CyCapture',
      attachmentId: crypto.randomUUID(),
      file,
      document: existingDocument,
      exportAudience: 'human',
      exportContainer: 'project',
      includeOriginalVideos: false,
      locale: 'fr',
      async onSave({ attachmentId, document, exportPreferences }) {
        await saveLocally(attachmentId, document, exportPreferences);
        return { revision: 1 };
      },
    });
    await editor.ready;
  }
</script>
```

Le protocole est `cyannota.integration`, version `1`. Les messages sont acceptés uniquement depuis la fenêtre d’origine et l’origine HTTP(S) exacte annoncée dans l’URL. L’hôte peut choisir les valeurs initiales d’export et récupère les éventuelles modifications de l’utilisateur dans `exportPreferences`. `locale` accepte `en` ou `fr` et vaut `en` par défaut ; cette langue s’applique à l’interface ainsi qu’aux prompts. Les capacités retournées par CyAnnota annoncent `locales: ['en', 'fr']` et `defaultLocale: 'en'`.

Pour CyTask, utiliser `integrationId: 'cytask'` et conserver le document d’annotations à côté de la pièce jointe. L’image ou la vidéo originale n’est pas dupliquée dans ce document ; CyTask demeure propriétaire du média et de son stockage.

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
