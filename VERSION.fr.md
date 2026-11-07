# CyAnnota 0.4.4 — Bêta

[English](VERSION.md) · [Français](VERSION.fr.md) · [README](README.fr.md) · [Release Windows](https://github.com/MrMybal/CyAnnota/releases/tag/v0.4.4)

CyAnnota reste en **bêta**, en cours de validation avant une version stable. L’application Windows publiée et l’édition en ligne affichent toutes deux la version **0.4.4**, mais l’édition en ligne est compilée depuis le dépôt et peut inclure des changements postérieurs à la release Windows.

## Version Windows publiée

La [release 0.4.4](https://github.com/MrMybal/CyAnnota/releases/tag/v0.4.4) fournit un installateur Windows x64, un exécutable portable et `SHA256SUMS.txt`.

- Ajout de l’import et de la conversion locale des modèles vers GLB, avec peinture indicative sur le mesh et références caméra enregistrées.
- Ajout des sessions de peinture contenant plusieurs traits et points de vue, avec validation, annulation et effacement.
- Amélioration de la navigation 3D, des modes Texturé/Solide/Wireframe, de la visibilité, de la transparence et des couleurs par défaut selon l’action.
- Enrichissement des intégrations embarquées : actions Envoyer/Fermer, résultats archive/directs, miniatures et fonctions de lecture des paquets.
- Ajout des fonctions de création structurée par IA et de l’import à côté des médias existants dans les sessions d’espace de travail CyAI.
- Ajout de l’export direct d’un ZIP dans le presse-papiers en complément de l’enregistrement classique.

## Édition en ligne et sources actuelles

L’[application en ligne](https://mrmybal.github.io/CyAnnota/) est hébergée sur GitHub Pages. La compilation statique séparée conserve les cibles Web locale et Windows. Le code correspondant est disponible dans [source.zip](https://mrmybal.github.io/CyAnnota/source.zip).

Le [changement de déploiement Web](https://github.com/MrMybal/CyAnnota/commit/7b323ae9eb45a45df3b03f07b76db96e0c7cd057) corrige aussi la préparation de la destination par défaut pour Sauver et les exports classiques, et adapte les chemins des ressources à l’hébergement sous `/CyAnnota/`. Ces changements sont postérieurs aux binaires Windows 0.4.4 publiés ; ils ne constituent pas une nouvelle compilation Windows.

## Limites connues

- Les paquets natifs publiés ciblent Windows x64. Aucun paquet d’application macOS ou Linux n’accompagne la release 0.4.4.
- Les opérations du presse-papiers Web dépendent des formats et permissions du navigateur. Le téléchargement du projet ou du ZIP reste la solution de repli si la copie d’archive est indisponible.
- Le décodage vidéo dépend des codecs du fichier et du navigateur. La conversion locale peut prendre du temps et consommer beaucoup de mémoire ; aucune performance ni taille de fichier maximale fixe n’est garantie.
- Les fichiers `.blend` ne sont pas convertis dans CyAnnota. Exportez-les d’abord en GLB depuis Blender.
- La compatibilité des modèles dépend du format choisi et de ses ressources. Incluez les fichiers complémentaires des glTF ou des modèles à textures externes ; un GLB autonome est plus simple à transférer. L’import OBJ ne charge pas de définition de matériaux MTL séparée.
- La peinture sur le mesh donne une indication approximative. Les actions de suppression, changement de couleur et séparation annotent une demande ; elles ne modifient ni la géométrie ni les matériaux du modèle.
- Les exports Humain contiennent les textes d’annotation et les données du projet sans fichiers de prompt. Utilisez Sauver pour conserver les médias sources ; les exports destinataires peuvent optimiser les images ou omettre les vidéos originales.

## Problèmes signalés

Les notes de release ne publient pas de liste détaillée bug par bug. Consultez le [suivi des problèmes](https://github.com/MrMybal/CyAnnota/issues) pour les signalements et l’[historique des releases](https://github.com/MrMybal/CyAnnota/releases) pour les changements publiés.

Pour signaler un problème, indiquez la version de CyAnnota, l’édition Web ou Windows, le navigateur si pertinent, le format du média, les étapes de reproduction et l’erreur affichée. Joignez si possible un petit fichier de démonstration public.
