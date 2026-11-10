# Atelier local

A local assistant that chats, looks at images and generates images and videos on your own computer. A GGUF language model (run by llama.cpp) talks with you, decides when a generation is useful and drives a native Python generation engine through tool calls. Nothing is sent to a cloud service: no remote API, telemetry or web assets.

The interface runs in your browser and uses French labels; their names are quoted below to help you find the controls. A small Node.js server (no npm dependencies) owns the language model and the generation worker.

> **Experimental branch `prototype-runner`.** Generation runs natively, without ComfyUI. Supported engines today: **Krea2** (image) and **LTX2.5** (video). See [runner/README.md](runner/README.md) for engine details, measured results and current limits.

## Getting started

Requirements:

- **Node.js 22 or later** in PATH and a recent browser.
- A **llama-server** build compatible with your GGUF model, with its native libraries. NVIDIA/CUDA is optional for chat: **Calcul → CPU uniquement** runs it on the processor.
- For generation: Windows or Linux x64 with a compatible NVIDIA GPU. The first activation downloads a private Python environment (several GB) into `data/runtime/`; your system Python is left untouched.

Start the application:

- Windows: double-click **Lancer-Windows.cmd**.
- Linux: `sh lancer-linux.sh`.
- Either system: `node scripts/launch.mjs --open` (or `npm start`).

Open **http://127.0.0.1:8787** if the browser does not open by itself. Keep the launcher window open: closing it, pressing `Ctrl+C` or choosing **Fermer l’application** in Configuration stops the app, its model and its generation worker. Launching again reuses an up-to-date instance or cleanly replaces an outdated idle one from the same folder.

## Models

Weights are never downloaded or moved by the app, and Git ignores them. Each folder under `models/` contains a short placement guide.

| Folder                  | Contents                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `models/LLMs/<name>/`   | One chat GGUF per folder (the folder name becomes its display name), plus generation text encoders |
| `models/vision/<name>/` | Matching `mmproj` vision projector for the chat model, plus generation projection files            |
| `models/checkpoints/`   | Image and video generation models                                                                  |
| `models/VAE/`           | Image, video and audio VAEs                                                                        |
| `models/LoRa/`          | LoRAs                                                                                              |

Open **Configuration** to pick the llama.cpp engine and the chat model. Detected folders are listed; **Ajouter un LLM** adds one by path. Use a model and chat template that support **native tool calls**: generation is only possible through real tool calls, never through text that imitates one. The engine starts with `--jinja`, in offline mode.

Some Qwen3.5 GGUF exports declare an MTP layer without its tensors; the app detects this and uses an in-memory metadata fix, or a compatibility copy in `data/model-cache` when needed. The original file is never modified.

## Chat and images

- Enter sends, Shift+Enter inserts a new line. The first message starts the model and waits for it.
- Attach PNG/JPEG images with the button, by drag and drop or by pasting. Up to 64 images per message; the browser prepares compressed analysis copies (longest side 1,024 px, four-megapixel budget shared across images).
- **Réflexion** asks the model's template to enable or disable reasoning.
- **Contexte total** and **Sortie maximale** set the context window and reply length; stop the model before changing them.
- **Consignes globales** (up to 16,000 characters) are captured by each new conversation at its first message.
- The gauge under the composer shows the context already used by the conversation; hover it for details.

## Generation

Enable generation in **Configuration → Génération**. The private Python environment is prepared automatically; its progress is shown there and chat remains available meanwhile.

**Workflows** are small JSON files, created and edited in **Configuration → Workflows**. The workflows shipped with Atelier live in `runner/workflows/` and come with every download and update. Your own workflows, and your edits of shipped ones, are saved in `workflow/`, which updates never touch: an update never replaces a workflow you edited or created. When it brings a new version of a workflow you edited, or one named like yours, the new one is listed beside yours as « … V2 » (then V3…). A shipped workflow you delete stays hidden until an update changes it. A workflow selects an engine, its local model files, LoRAs and reference slots, and decides who controls each parameter:

- **Fixe** — your value, invisible to the assistant;
- **Assistant** — the assistant chooses within your limits;
- **Aléatoire** — a seed drawn once, before approval.

The description you write is what the assistant reads to choose a workflow. **Importer un workflow** pre-fills the editor from an Atelier JSON or a ComfyUI API or editor file; importing never runs anything, and settings the engine cannot execute stay visible under **Réglages source**.

When the assistant calls a generation tool:

1. the request is validated against the workflow and shown for approval. Images can be approved once or for all future images; **every video needs its own confirmation**, including draft → final promotion;
2. the chat model and its projector are unloaded to free the GPU;
3. the Python worker runs the job, then confirms that GPU memory was released;
4. the chat model is reloaded and the result appears in the chat and in **Output**.

After an image, the assistant receives the result's metadata only; it can look at a compressed copy with `local_read_output` when you ask for a check or it has a reason to. For videos it receives a few compressed, timestamped frames: enough to describe content, not to judge continuous motion. Originals are written to `output/`; deleting conversations never deletes them.

The default limit is five generations per user message (1 to 9,999, or ∞).

## Resources, Output and history

The right-hand panel has **Ressources** and **Output** tabs. Resources are images or videos you drop there; they are copied to `data/resources/`, labelled `Ref 1`, `Ref 2`… and stay available across conversations. Active resources are listed to the assistant as text; it reads their pixels only through the `local_read_resource` tool, and can use them as generation references.

**Conserver les conversations** (on by default) saves conversations, reasoning and compressed images under `history/`. Turning it off stops new writes without deleting anything; **Supprimer l’historique** deletes saved conversations and their compressed copies, never generated originals. Conversations can be grouped into projects from the home view.

Conversations created with earlier ComfyUI-based versions remain readable: their compressed copies are kept, but their originals stay in ComfyUI and are shown as unavailable.

## Updates

At launch, one background request checks the public version of this repository. When a newer stable version exists, a button appears next to Configuration; clicking it downloads the pinned source archive, backs up the replaced sources, restarts and restores the open conversation. `data/`, `history/`, `output/`, `workflow/`, models and Git metadata are preserved.

## Security

The server listens only on `127.0.0.1`. Control routes check host, origin and a session token. Remote image URLs are rejected. Only one generation runs at a time.

## Development

```sh
npm test                                   # Node tests (simulated engines, no GPU)
python -s -m unittest discover -s runner/tests -v   # Python worker tests
```

The Node suite uses simulated llama.cpp and generation workers; it checks behavior, not model quality or speed. Code style: `npx prettier --write .` for JavaScript and CSS, `ruff format --config runner/pyproject.toml runner` for Python.

## Troubleshooting

- **Engine exits:** Configuration → **Journaux du moteur**. An unknown option or architecture usually means an outdated llama.cpp build.
- **Out of memory:** stop the model, reduce the context or the number of GPU layers.
- **Generation tool unavailable:** check that generation is enabled, its environment is ready, at least one workflow is enabled and valid, and the chat model supports native tool calls.
- **Port in use:** another instance may be using 8787.

## References and licensing

- [llama.cpp](https://github.com/ggml-org/llama.cpp) and its [server documentation](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
- [Source distribution notes](DISTRIBUTION.md) and [third-party components](THIRD_PARTY_NOTICES.md)

Atelier local is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE): you may download, use, modify and share it for any noncommercial purpose. Commercial use requires separate permission. Engines, Python libraries, models and projectors are supplied separately and keep their own licenses.
