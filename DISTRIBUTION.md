# Distribution des sources

Cette archive contient les sources de l'application et son lanceur Windows/Linux. Elle exclut la configuration locale, les chemins propres à un ordinateur, les caches, les modèles, les binaires, le rapport matériel et les documents internes de conception.

## Licence de l'application

Les sources sont publiées sous **PolyForm Noncommercial 1.0.0** (texte complet dans `LICENSE`). Elles peuvent être téléchargées, utilisées, modifiées et redistribuées pour tout usage non commercial, à condition de transmettre la licence et la ligne `Required Notice:`. Tout usage commercial demande une autorisation séparée. Ce n'est pas une licence « open source » au sens de l'OSI.

Conséquence pour le développement : aucun code sous licence GPL ou AGPL (notamment ComfyUI et une partie de ses nœuds) ne peut être intégré, car ces licences interdisent d'ajouter une restriction non commerciale. Du code MIT, BSD ou Apache-2.0 peut l'être en conservant ses mentions ; il est alors listé dans `THIRD_PARTY_NOTICES.md`.

## Composants fournis séparément

- Node.js : environnement d'exécution, non inclus dans l'archive. Son code principal utilise une licence MIT, et sa distribution contient également les licences de ses composants : https://github.com/nodejs/node/blob/main/LICENSE
- llama.cpp : moteur d'inférence externe, non inclus dans l'archive, sous licence MIT : https://github.com/ggml-org/llama.cpp/blob/master/LICENSE
- Les modèles et projecteurs GGUF sont fournis séparément et restent soumis aux licences de leurs auteurs.
- Branche expérimentale `prototype-runner` : les bibliothèques Python de génération sont des dépendances externes, non embarquées ; leurs licences sont listées dans `THIRD_PARTY_NOTICES.md`. Les checkpoints image/vidéo, tokenizers, LoRAs et leurs licences restent séparés des sources. Consulter `runner/README.md` pour les versions testées et les limites du moteur natif.
- L’activation de la génération prépare automatiquement Python et ses bibliothèques dans `data/runtime/` avec uv. Ces téléchargements ne sont pas publiés dans Git ; ils restent soumis aux licences de leurs projets. uv : https://github.com/astral-sh/uv ; distributions Python : https://github.com/astral-sh/python-build-standalone. `runner/pyproject.toml` et `runner/uv.lock` décrivent les dépendances installées.

L'application n'embarque ni police web, ni image externe, ni bibliothèque npm tierce. Si des binaires, modèles ou autres ressources sont ajoutés ultérieurement au dépôt, examiner leurs licences et conserver les mentions requises avant redistribution.

## Configuration après utilisation

L'exécution crée data/config.json et éventuellement un cache de modèle sous data/. Le fichier .gitignore exclut ce dossier pour les ajouts avec Git. Pour une publication manuelle via le site GitHub, sélectionner seulement les fichiers de cette archive et conserver data/ en local.

## Historique facultatif

Lorsque la conservation est activée, history/ contient des conversations, raisonnements et copies des images compressées. Ce dossier est exclu de Git. Ne pas l’inclure dans une archive de sources ni dans un téléversement manuel. Désactiver l’option ne supprime pas les fichiers existants.

Le dossier models/ contient uniquement un guide de placement dans les sources. Les poids GGUF sont ignorés par Git. Les chemins de la bibliothèque personnelle sont dans data/models.json et ne sont pas publiés.
