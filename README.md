# Atelier local

**English** | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

A local chat, image-understanding and optional ComfyUI image-generation interface for GGUF models, built with HTML, CSS and JavaScript. The interface runs in your browser, while a small Node.js server manages llama.cpp. No npm dependencies, remote assets, telemetry or cloud APIs.

The application currently uses French UI labels. Their names are included below to help you find the controls.

## Getting started

Requirements: **Node.js 22 or later**, a recent browser, and a **recent llama-server build with Qwen3.5 and vision support**, together with its native libraries. Choose a build that matches your operating system, architecture and hardware. The application does not download models or install dependencies automatically.

On Windows, double-click **Lancer-Windows.cmd**.

On Linux:

```sh
sh lancer-linux.sh
```

The same command also works on both systems:

```sh
node server.mjs --open
```

Open **http://127.0.0.1:8787**. Keep the terminal running; `Ctrl+C` stops the application and the engine it started. If the browser does not open automatically, enter the address manually. Port 8787 must be available.

There is no need to run `npm install`. You can also use `npm start`.

## Configuring the files

Open **Configuration**, select the files with **Parcourir…** or enter their full paths, then click **Enregistrer** (Save):

The **Parcourir…** buttons open the Windows file picker or an installed Linux zenity/kdialog picker. Files stay in place and are not uploaded. If no Linux picker is available, enter the full path manually.

| Component | Example file from the original model release |
|---|---|
| Engine | `llama-server.exe` on Windows or `llama-server` on Linux |
| Q6_K model | [DeepSeek-V4-Pro-Qwen3.5-9B.Q6_K.gguf](https://huggingface.co/mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-GGUF/blob/main/DeepSeek-V4-Pro-Qwen3.5-9B.Q6_K.gguf) |
| FP16 vision projector | [DeepSeek-V4-Pro-Qwen3.5-9B.mmproj-f16.gguf](https://huggingface.co/mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-GGUF/blob/main/DeepSeek-V4-Pro-Qwen3.5-9B.mmproj-f16.gguf) |

These examples use the original [Jackrong/DeepSeek-V4-Pro-Qwen3.5-9B](https://huggingface.co/Jackrong/DeepSeek-V4-Pro-Qwen3.5-9B) release. The GGUF files are available in the [corresponding quantization repository](https://huggingface.co/mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-GGUF/tree/main). Use a projector that matches your model; leave its field empty for text-only use. Keep the engine's DLL/SO libraries in the directory layout supplied by its distributor.

The model path must point to the **file**, even if it is inside a folder with a similar name. On Windows, use File Explorer's **Copy as path** command; surrounding quotation marks are accepted. A generic Linux example is `/path/to/models/model.Q6_K.gguf`.

GGUF files are not uploaded into the browser. File paths are saved in `data/config.json`. Personal configuration files are excluded from the source distribution.

Some Qwen3.5 GGUF exports declare an MTP layer without including its tensors. The application detects this specific mismatch. It uses an in-memory metadata override when possible. If per-layer metadata arrays also include the missing layer, it prepares a **compatibility copy** in `data/model-cache`, correcting the metadata while preserving the positions and bytes of the weights. The original downloaded file is unchanged. The copy requires roughly one model's worth of additional disk space and is reused on later starts. Models with an actual MTP layer are left unchanged. Missing or corrupted model weights cannot be repaired by this mechanism.

The llama.cpp engine included in some Ollama installations can be reused directly. The application detects CUDA libraries in `cuda_v12` or `cuda_v13` subdirectories next to the engine. It does not start or reconfigure the Ollama service, and it respects an existing `GGML_BACKEND_PATH` environment variable.

## Appearance

The interface starts in **Night** mode. Use the **Day / Night** button beside Configuration to switch themes. Your choice is saved in `data/preferences.json` and restored after closing or restarting the application. This file stays local and is excluded from Git. The floating controls remain visible as the chat scrolls behind them.

## Chat and images

The first message automatically starts the configured model and its vision projector, if provided. The message waits until loading completes, then sends once. Images can be attached before startup when a projector is configured. You can cancel the waiting message; its text and images return to the composer while model loading continues. A loading failure also preserves the message. Manual start/stop controls remain available.

- Type a message and press Enter. Shift+Enter inserts a new line.
- Attach PNG/JPEG images with the image button, by dragging them onto the composer, or by pasting an image into the message field.
- Attach up to 64 images per message, with a maximum of 64 MiB per source file. The browser prepares analysis copies with a maximum 1,024-pixel longest side and a shared four-megapixel budget. It keeps the smaller PNG or JPEG result; JPEG uses quality `0.82` and a white background. A conversation request remains limited to 20 MiB and 100 messages; start a new conversation when either limit is reached.
- **Réflexion** (Thinking) asks the model's chat template to enable or disable reasoning. Its effect depends on the model. Received reasoning appears in a separate collapsible section.
- The square button interrupts the current response. Text already received is kept.
- **Contexte total** is the shared window for messages, image tokens, reasoning and the reply. **Sortie maximale** independently limits generated tokens per reply, including reasoning: 4,096 by default, with choices up to 32,768 within the selected context. The interface reports a response cut short by an output or context limit. Stop the model before changing these settings, then save; they apply on its next start.
- Model replies render common Markdown: headings, paragraphs, bold and italic text, strikethrough, lists, quotations, simple tables, links, and inline or fenced code. Formatting updates while the reply streams. Raw model HTML is escaped, unsafe link protocols are rejected, and embedded image syntax does not load remote images.

## Local image generation with ComfyUI

ComfyUI tools are **disabled by default**. Run your own local ComfyUI instance, then open **Configuration → ComfyUI**, enable the connection and enter its API address. The default is `http://127.0.0.1:8188`; a Comfy backend used through SwarmUI may use another local port, such as `http://127.0.0.1:7821`. Use the backend's actual API address. The application does not install ComfyUI, download models or bundle third-party workflows.

Export a copy of your workflow from ComfyUI using **File → Export (API)**, enabling developer options if necessary. Import this **API-format JSON** in Configuration. Ordinary editor workflow JSON, including complex subgraphs, must be exported through ComfyUI first; the application does not convert it. Imported copies are saved under ignored `data/workflows/`; your original workflow is untouched. Set a name and description, identify the saved-image output nodes, and provide explicit node/input bindings for the required `prompt` and any supported `negative_prompt`, `seed`, `width`, `height` and `image`. Mark image-editing workflows that require a reference. The model can change only these mapped inputs. Width and height must be multiples of 8 between 64 and 4,096; a seed must be a nonnegative safe integer.

Use a **GGUF model and chat template that support native tool calls**. The application supplies the tools and starts llama-server with `--jinja`; no extra manual engine flag is needed. A text imitation of a tool call does not execute a workflow. For workflows with an image binding, the model can select a supplied reference using its zero-based index.

Every execution asks for permission by default. You can approve once or allow imported workflows globally, then revoke that setting in Configuration. The default limit is **three generations per user turn**, adjustable from 1 to 9,999 or **∞** (10,000 internally). The approval names the workflow and parameters; progress and cancellation stay visible. Restoring a conversation never silently replays an approval or starts a pending job.

During a run, the application waits for ComfyUI to be idle, unloads the chat engine and its vision projector, then runs the approved workflow. It frees ComfyUI's models before restarting the chat engine and projector for review. The local ComfyUI service stays running. Only compressed analysis copies go to the vision model; it compares them with the instruction and references and can revise within the iteration limit. Its review can miss details lost in compression and does not train the model. The **right-hand gallery** shows workflow and prompt details and lets you view or download the original ComfyUI output.

ComfyUI is detected by checking the saved address and the usual local ports 8188 and 7821, without a port scan. A detected address stays visible and read-only; **Modifier** enables manual entry. **Tester la connexion**, next to the address label, checks the address currently displayed. **Enregistrer** and **Enregistrer et démarrer** save both model and ComfyUI settings; there is no separate ComfyUI save button. ComfyUI-only changes can be saved while the chat model is running.

The generation counter has −/+ controls and an **∞** option (a backend ceiling of 10,000 attempts). Context, message and memory limits still apply. **Ajouter des workflows…** accepts multiple API JSON files and asks for a description for each one. Descriptions can also be edited in the workflow list and saved with the main buttons. The model receives all registered names, descriptions and supported inputs, and is instructed to select the most appropriate workflow.

## Optional conversation history

**Conserver les conversations** in Configuration is off by default. When off, messages stay in page memory and are lost on closure or reload. When enabled, the application saves messages, reasoning and copies of the browser-compressed images under `history/<conversation-id>/` in the project folder. Each conversation has `conversation.json` and content-addressed image files; repeated saves reuse the same image bytes. Both `history/` and `data/` are excluded from Git. When uploading sources manually, exclude both folders yourself.

Saved conversations appear in the sidebar, or inside Configuration on narrow screens. Reopen one to restore messages and images and continue chatting. Pending user turns, periodic partial replies and finished replies are saved. An unfinished user turn is restored as an editable draft and is never resent automatically. A restored partial assistant reply is marked as partial. A forced shutdown can still lose the latest unsaved part of a streamed reply.

Generated-image history keeps compressed review copies and gallery metadata/links only. Originals remain in ComfyUI's output storage. **Supprimer l’historique** deletes the saved compressed copies and links along with the conversation; it leaves original ComfyUI files unchanged. With history off, gallery records stay in page/server memory only.

Disabling history stops further writes and hides the list; it does **not delete** existing files. The red **Supprimer l’historique** button permanently deletes saved conversations and their images after confirmation, even when saving is disabled. It also closes the displayed exchange while keeping the current composer draft. The saving preference is retained; future exchanges can be saved again. Enabling it during a conversation saves the current exchange. Files are ordinary local files, grow as conversations accumulate, and can be backed up or removed manually while the app is closed. History does not increase the model's active context window: reopening an archive sends its restored messages only when you submit a new prompt, with the same context and request-size limits. Saving failures are reported and keep the conversation in the page; switching to another conversation is blocked until saving succeeds or history is disabled.

**Nouvelle conversation** preserves saved exchanges. With history off, it asks before clearing an existing conversation. Reloading the page does not unload the model: use **Arrêter le modèle** or stop the server. The model-card border is green when ready, red when stopped or unavailable, and amber while loading or stopping; its accessible label also reports the state.

## Memory and hardware

The default context is **8,192 tokens**, with all available model layers requested on the GPU. Context choices range from 4,096 to 262,144 tokens; the largest choices are advanced options, not a guarantee that a machine or a different GGUF model supports them. The Qwen3.5-9B base model declares a native context of 262,144 tokens ([model documentation](https://huggingface.co/Qwen/Qwen3.5-9B)), while available RAM/VRAM and the engine determine practical capacity. The initial profile targets a 12 GB graphics card, but actual memory use depends on the model, context and images. If the engine reports insufficient memory, stop it, then reduce the context or select fewer GPU layers in Configuration.

**CPU uniquement** (CPU only) runs inference on the processor and disables GPU offloading for the vision projector. It may be much slower. Windows/Linux support does not mean that every computer has enough memory for a 9B model. A machine without NVIDIA hardware can use a CPU engine or a llama.cpp build suited to its GPU.

The application does not apply or modify GPU unlocking tools. Windows has been exercised locally; Linux runtime behavior has not yet been verified.

## Image limits and compression

The limit is **64 images per message**. Analysis images share a **four-megapixel budget**, with a maximum 1,024-pixel longest side per image. With many references, each receives fewer pixels; 64 full-resolution images are not sent to the model. The browser compares PNG with JPEG at quality `0.82` and keeps the smaller result. The JPEG quality parameter is **not an 82% size reduction**. JPEG uses a white background. History stores images as prepared for inference without recompressing them again. ComfyUI originals are viewed and downloaded separately.

The browser sends the whole active conversation on each turn, including past images. Base64 adds roughly one third to binary image size, and the complete JSON request remains limited to **20 MiB and 100 messages**, including native tool messages. Reducing image bytes helps storage and transport, but does not directly reduce image tokens; dimensions and the vision encoder's processing determine those. Many images can still exhaust the model's context or obscure small details. The 64-image attachment limit does not guarantee that every model or context can process all of them usefully.

## Troubleshooting

- **File not found:** check the full path and make sure the download has finished.
- **Engine exits:** open Configuration → **Journaux du moteur** (Engine logs). An unknown option can indicate an outdated engine. An unknown architecture or incompatible projector requires a compatible engine build and matching files.
- **CUDA not detected:** check the engine distribution, its libraries and your drivers. Requesting GPU layers does not guarantee GPU use; the engine logs report actual offloading.
- **Context exceeded:** start a new conversation or increase the context if memory allows. History is not silently removed.
- **ComfyUI import or tool unavailable:** export with File → Export (API), check the local API address and enable ComfyUI, then verify the prompt binding and the GGUF's native tool support. An image-editing workflow also needs a supplied reference and an image binding.
- **Connection interrupted:** check the terminal, then reload the page. If history is disabled, copy useful conversation text first; if enabled, make sure saving has finished.
- **Port in use:** another instance may be using 8787. Close that instance before restarting.

Both services listen only on loopback. Control routes check the host, origin and a session token. Remote image URLs are rejected, and llama.cpp starts in offline mode. Only one generation is accepted at a time.

## Smoke test

```sh
node --test tests/*.mjs
```

Alternatively, run `npm test` or `npm run smoke`. Both run all top-level test files; fixture scripts in `tests/fixtures/` are excluded. The suite uses **simulated HTTP engines and local ComfyUI responses** to check chat, access restrictions, history, workflow validation, native tool approval, GPU handoff/recovery and gallery storage alongside startup, streaming, images, cancellation, CUDA library discovery and MTP compatibility handling. It does not measure the quality or speed of a real model or image workflow.

## References and licensing

- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [Server and API documentation](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
- [Multimodal input documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)
- [Source distribution notes](DISTRIBUTION.md)

The engine, models and projectors are supplied separately and retain their own licenses.
