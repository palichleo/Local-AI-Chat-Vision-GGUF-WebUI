# Atelier local

Un chat local avec analyse d'images, écrit en HTML, CSS et JavaScript. L'interface fonctionne dans un navigateur ; un petit serveur Node.js pilote llama.cpp. Aucune dépendance npm, ressource distante, télémétrie ou API cloud.

## Démarrer

Prérequis : **Node.js 22 ou ultérieur**, un navigateur récent et un **llama-server récent compatible Qwen3.5 et vision**, accompagné de ses bibliothèques natives. L'exécutable doit correspondre au système, à l'architecture et au matériel. Aucun téléchargement n'est lancé par cette application.

Sous Windows, double-cliquer sur **Lancer-Windows.cmd**.

Sous Linux :

```sh
sh lancer-linux.sh
```

La commande commune aux deux systèmes est :

```sh
node server.mjs --open
```

L'application s'ouvre sur **http://127.0.0.1:8787**. Garder son terminal ouvert. `Ctrl+C` arrête le serveur et le moteur qu'il a lancé. Si l'ouverture du navigateur échoue, saisir l'adresse manuellement. Le port 8787 doit être libre.

Il n'est pas nécessaire d'exécuter `npm install`. `npm start` est également disponible.

## Configurer les fichiers

Ouvrir **Configuration**, renseigner les trois chemins complets, puis choisir **Enregistrer et démarrer** :

1. L'exécutable `llama-server.exe` sous Windows ou `llama-server` sous Linux. Les bibliothèques DLL/SO de sa distribution doivent rester avec lui, dans leur organisation d'origine.
2. Le fichier `DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic.Q6_K.gguf`.
3. Le fichier `DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic.mmproj-f16.gguf`, pour la vision. Laisser ce champ vide pour le texte seul.

Le chemin du modèle doit viser le **fichier**, même si celui-ci se trouve dans un dossier portant presque le même nom. Sous Windows, « Copier en tant que chemin d'accès » dans l'Explorateur permet de récupérer ce chemin ; les guillemets extérieurs sont acceptés. Sous Linux, donner par exemple `/home/moi/modeles/modele.Q6_K.gguf`.

Les fichiers GGUF ne sont pas chargés dans le navigateur. Les chemins sont enregistrés dans `data/config.json`. L'archive de distribution ne contient pas la configuration personnelle d'un autre ordinateur.

Certains GGUF Qwen3.5 déclarent une couche MTP absente de leurs poids. L'application détecte ce cas précisément. Si un override en mémoire suffit, elle l'utilise. Si un tableau de métadonnées inclut aussi cette couche fantôme, elle prépare une **copie de compatibilité** dans `data/model-cache` : compteurs et tableaux corrigés, position et octets des poids préservés. Le fichier téléchargé reste intact. Cette copie demande autant d'espace disque que le modèle (environ **7,36 Go supplémentaires** pour ce Q6_K), puis est réutilisée aux lancements suivants. Un GGUF dont les tenseurs MTP sont présents n'est pas corrigé. L'application ne répare pas des poids manquants ou corrompus.

Le moteur llama.cpp inclus dans certaines installations d'Ollama peut être réutilisé directement. L'application détecte les bibliothèques CUDA disposées dans les sous-dossiers `cuda_v12` ou `cuda_v13` à côté du moteur. Cela ne lance ni ne reconfigure le service Ollama. Un `GGML_BACKEND_PATH` déjà défini dans l'environnement est respecté.

## Chat et images

- Écrire un message, puis appuyer sur Entrée. Maj+Entrée ajoute une ligne.
- Joindre des images PNG/JPEG avec le bouton image, par glisser-déposer ou en collant une image dans la saisie.
- Maximum trois images par message et 10 Mo par fichier source. Les images sont redimensionnées à 2 048 pixels sur le plus grand côté et converties en JPEG sur fond blanc avant envoi local. La limite totale d'une conversation envoyée est de 20 Mo ; recommencer une conversation si elle contient trop d'images.
- Le bouton **Réflexion** demande au template du modèle d'activer ou désactiver le raisonnement. Son effet dépend du modèle. Le raisonnement reçu apparaît dans un bloc repliable distinct.
- Le bouton carré interrompt la réponse en cours. Le texte déjà reçu est conservé.
- La génération est limitée à 4 096 tokens par réponse, raisonnement compris. Un message signale une réponse tronquée.
- Les blocs de code sont affichés comme du texte. Le HTML produit par le modèle n'est jamais exécuté. Le reste du Markdown est conservé sous forme de texte dans cette première version.

La conversation reste dans la mémoire de la page : **fermer ou recharger la page la perd**. Les chemins de configuration sont conservés. « Nouvelle conversation » demande confirmation si une conversation existe déjà. Un rechargement ne décharge pas automatiquement le modèle : utiliser « Arrêter le modèle » ou fermer le serveur.

## Mémoire et compatibilité matérielle

Le profil initial est de **8 192 tokens** avec toutes les couches disponibles sur le GPU. Le profil initial vise une carte graphique de 12 Go ; la consommation réelle dépend aussi du contexte et des images. Si le moteur signale un manque de mémoire, diminuer le contexte ou choisir moins de couches GPU dans Configuration après l'avoir arrêté.

Le choix **CPU uniquement** charge le calcul sur le processeur et désactive aussi le déport du projecteur sur le GPU. Il peut être beaucoup plus lent. Le fonctionnement Windows/Linux du code de l'application ne signifie pas que ce modèle tient dans la mémoire de tout ordinateur. Une machine sans NVIDIA peut utiliser un moteur CPU ou une distribution llama.cpp adaptée à son GPU.

L'application n'applique et ne modifie aucun débridage de carte graphique.

## Dépannage

- **Fichier absent** : vérifier le chemin complet et que le téléchargement est terminé.
- **Le moteur se ferme** : ouvrir Configuration → Journaux du moteur. Une option inconnue peut indiquer un moteur trop ancien ; une architecture inconnue ou un projecteur incompatible nécessite une version et des fichiers compatibles.
- **CUDA non détecté** : vérifier la distribution du moteur et ses bibliothèques, puis les pilotes. Le nombre de couches demandé ne garantit pas à lui seul l'utilisation du GPU ; les journaux du moteur indiquent le déport réel.
- **Contexte dépassé** : recommencer une conversation ou augmenter le contexte si la mémoire le permet. L'historique n'est pas supprimé silencieusement.
- **Connexion interrompue** : vérifier le terminal, puis recharger la page. Copier le texte utile auparavant, puisque l'historique de cette version n'est pas persistant.
- **Port occupé** : une autre instance utilise peut-être 8787. Fermer cette instance avant de relancer.

Les services écoutent seulement sur la boucle locale. Les routes de contrôle vérifient l'hôte, l'origine et un jeton de session. Les images distantes sont refusées et llama.cpp est lancé en mode hors ligne. Une seule génération est acceptée à la fois.

## Smoke test

```sh
node --test tests/smoke.mjs
```

Ou `npm run smoke`. Le smoke emploie un **moteur HTTP simulé**, clairement séparé dans `tests/fixtures/`. Il vérifie le lancement, la configuration, les restrictions d'accès, le flux texte et raisonnement, les images, l'annulation, l'arrêt et le passage des bibliothèques CUDA. Il ne mesure ni la qualité ni la vitesse du modèle réel.

## Sources

- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [Serveur et API](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
- [Entrées multimodales](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)

Les GGUF et le moteur sont fournis séparément et conservent leurs propres licences.
