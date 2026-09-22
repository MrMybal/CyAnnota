# Création et édition de projets CyAnnota par une IA

Le SDK `public/cyannota-ai.js` permet à un modèle doté de capacités visuelles ou spatiales de produire des annotations exploitables par CyAnnota. Le modèle génère un petit document JSON ; l’application hôte conserve les médias sous forme de `Blob` et construit le fichier `.cyannota` localement.

Le schéma complet se trouve dans [`cyannota-ai.schema.json`](cyannota-ai.schema.json). Il peut être fourni directement à un modèle comme schéma de sortie structurée.

## Principes

- Toutes les coordonnées sont normalisées de `0` à `1` par rapport à la largeur et à la hauteur du média.
- L’origine `(0, 0)` se trouve en haut à gauche.
- Pour une vidéo ou un GIF, `time.start` et `time.end` sont exprimés en secondes.
- Le média original n’est jamais placé dans le JSON envoyé au modèle. L’application hôte le conserve localement et l’associe à l’identifiant de l’onglet.
- Un modèle peut renvoyer un document complet ou une liste limitée d’opérations d’édition.

## Créer un projet

```html
<script src="/vendor/jszip.min.js"></script>
<script src="/cyannota-ai.js"></script>
<script>
  const document = CyAnnotaAI.createDocument({
    title: 'Navigation review',
    locale: 'fr',
    workspaceMessage: 'Améliorer la lisibilité générale sans changer la charte.',
    tabs: [{
      id: 'capture-home',
      label: 'Accueil',
      kind: 'image',
      mediaName: capture.name,
      width: 1920,
      height: 1080,
      message: 'Vérifier la navigation principale.',
      annotations: [{
        id: 'nav-contrast',
        type: 'box',
        category: 'modifier',
        color: '#ff5c49',
        message: 'Augmenter le contraste de cette navigation.',
        box: { x: 0.05, y: 0.04, width: 0.9, height: 0.1 }
      }]
    }]
  });

  const validation = CyAnnotaAI.validateDocument(document);
  if (!validation.valid) throw new Error(validation.errors.join('\n'));

  const result = await CyAnnotaAI.createPackage(document, {
    JSZip,
    media: { 'capture-home': capture },
    audience: 'ai'
  });

  await conversation.attach(new File(
    [result.archive],
    result.archiveName,
    { type: 'application/x-cyannota' }
  ));
</script>
```

## Vidéo ou GIF

Le modèle utilise les mêmes coordonnées, auxquelles il ajoute une plage temporelle :

```json
{
  "id": "button-delay",
  "type": "arrow",
  "message": "Le retour visuel arrive trop tard après le clic.",
  "from": { "x": 0.72, "y": 0.81 },
  "to": { "x": 0.84, "y": 0.81 },
  "time": { "start": 12.4, "end": 15.2 }
}
```

Un GIF est déclaré avec `kind: "gif"`. CyAnnota l’ouvre dans son éditeur temporel, comme une vidéo.

## Modifier un projet existant

Les modifications sont atomiques et ciblent des identifiants stables :

```js
const edited = await CyAnnotaAI.editPackage(existingCyannotaFile, [
  {
    op: 'update-annotation',
    tabId: 'capture-home',
    annotationId: 'nav-contrast',
    patch: {
      message: 'Augmenter le contraste et conserver un ratio WCAG AA.',
      box: { x: 0.04, y: 0.03, width: 0.92, height: 0.12 }
    }
  },
  {
    op: 'add-annotation',
    tabId: 'capture-home',
    annotation: {
      id: 'missing-label',
      type: 'note',
      category: 'ajouter',
      message: 'Ajouter un libellé accessible.',
      point: { x: 0.67, y: 0.54 }
    }
  }
], { JSZip });
```

Les opérations disponibles sont :

- `set-title` ;
- `set-workspace-message` ;
- `set-tab-message` ;
- `add-annotation` ;
- `update-annotation` ;
- `remove-annotation`.

`editPackage` sait convertir un projet CyAnnota classique vers le format de travail IA. Le nouveau paquet contient ensuite `ai-source.cyannota.json`, ce qui rend les éditions suivantes directes et préserve les identifiants.

## Consigne recommandée pour le modèle

> Analyse le média dans son ensemble. Retourne uniquement un document conforme au schéma CyAnnota AI version 1. Utilise des coordonnées normalisées entre 0 et 1, l’origine étant en haut à gauche. Chaque annotation doit avoir une consigne autonome et précise. Pour une vidéo ou un GIF, indique une plage temporelle en secondes. Ne déduis pas un changement non visible sans l’expliquer dans le message.

L’application hôte doit toujours exécuter `validateDocument` avant de construire ou modifier un fichier.
