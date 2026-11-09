# Distribution des sources

Cette archive contient les sources de l'application et son lanceur Windows/Linux. Elle exclut la configuration locale, les chemins propres à un ordinateur, les caches, les modèles, les binaires, le rapport matériel et les documents internes de conception.

## Licence de l'application

Aucune licence de réutilisation n'a encore été attribuée aux sources de l'application. Pour les proposer comme logiciel open source, choisir une licence et ajouter son texte dans un fichier LICENSE à la racine du dépôt.

## Composants fournis séparément

- Node.js : environnement d'exécution, non inclus dans l'archive. Son code principal utilise une licence MIT, et sa distribution contient également les licences de ses composants : https://github.com/nodejs/node/blob/main/LICENSE
- llama.cpp : moteur d'inférence externe, non inclus dans l'archive, sous licence MIT : https://github.com/ggml-org/llama.cpp/blob/master/LICENSE
- Les modèles et projecteurs GGUF sont fournis séparément et restent soumis aux licences de leurs auteurs.
- Branche expérimentale `prototype-runner` : Python, PyTorch, Diffusers, Transformers, Accelerate, Safetensors, Pillow, NumPy, Triton, comfy-kitchen, PyAV et ImageIO/FFmpeg sont des dépendances externes, non embarquées. Les checkpoints image/vidéo, tokenizers, LoRAs et leurs licences restent séparés des sources. Consulter `runner/README.md` pour les versions testées et les limites du moteur natif.

L'application n'embarque ni police web, ni image externe, ni bibliothèque npm tierce. Si des binaires, modèles ou autres ressources sont ajoutés ultérieurement au dépôt, examiner leurs licences et conserver les mentions requises avant redistribution.

## Configuration après utilisation

L'exécution crée data/config.json et éventuellement un cache de modèle sous data/. Le fichier .gitignore exclut ce dossier pour les ajouts avec Git. Pour une publication manuelle via le site GitHub, sélectionner seulement les fichiers de cette archive et conserver data/ en local.

## Historique facultatif

Lorsque la conservation est activée, history/ contient des conversations, raisonnements et copies des images compressées. Ce dossier est exclu de Git. Ne pas l’inclure dans une archive de sources ni dans un téléversement manuel. Désactiver l’option ne supprime pas les fichiers existants.

Le dossier models/ contient uniquement un guide de placement dans les sources. Les poids GGUF sont ignorés par Git. Les chemins de la bibliothèque personnelle sont dans data/models.json et ne sont pas publiés.
