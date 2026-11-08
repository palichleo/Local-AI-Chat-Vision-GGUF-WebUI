# Atelier local

**English** | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

A local chat, image-understanding and optional ComfyUI image-generation interface for GGUF models, built with HTML, CSS and JavaScript. The interface runs in your browser, while a small Node.js server manages llama.cpp. No npm dependencies, remote assets, telemetry or cloud APIs.

The application currently uses French UI labels. Their names are included below to help you find the controls.

A running server keeps its HTML, scripts and styles together in memory until it stops. Editing or replacing source files therefore requires a complete application restart. The launcher reports an already running version that differs from the files on disk instead of silently reopening it. Automatic updates already stop and restart the application. This prevents a new interface from requesting modules that an older backend cannot serve.

## Settings and global context

The settings dialog groups LLMs, global instructions, the shared llama.cpp engine and compute limits, ComfyUI, preferences and diagnostics. The search at the top filters settings without changing their values. Matching collapsed details open for the search and return to their prior state when it is cleared.

The LLM list starts on the configured model. Open **Chemins** to edit its name and GGUF paths, or **Ajouter un LLM** to start a blank editor. Detected folders supply the initial name; it can be customized without renaming the folder. The editor's **Enregistrer** saves the name and paths and selects that model; other unsaved settings remain pending. The dialog's bottom **Enregistrer** saves the complete configuration. llama.cpp is configured separately and shared by all LLMs.

**Consignes globales** saves up to 16,000 characters as user-supplied context for new conversations. Each conversation captures this text when its first message is submitted. Later changes affect future conversations; saved conversations and update checkpoints retain the original context. It occupies one initial system-context entry, not a new message on every turn. The stateless engine still receives the full active context with each inference request. Existing archives without instructions keep an empty context.


## Video proposals and confirmation

When importing an API workflow, select **Vidéo · MP4 / WebM**, declare whether it supports drafts, finals, or both, and select its saved-video output node. Map the prompt and optional seed, width, height, frame count and FPS. Reference inputs keep their explicit names and role descriptions (for example, start image, end image or style); the app does not infer these roles from a workflow or model name. Describe any constraints of custom nodes in the workflow description. Existing image workflows keep their behavior.

The separate native **comfy_generate_video** tool requires an intention and an explicit **draft/final** stage. **Every video call opens its own confirmation**, including retries and finalizations, even when automatic image generation is allowed. The proposal shows the intention, workflow, prompt, actual mapped values including defaults, and selected references. **Confirmer et générer** confirms that single immutable request; **Modifier** cancels it and lets you describe changes in chat; **Annuler** cancels it. Nothing is submitted and the LLM stays loaded while approval is pending. Changing the workflow or Comfy address requires a new proposal. Approvals expire after fifteen minutes and cannot be reused.

Original MP4/WebM files stay in ComfyUI and stream to the chat, Output and Details views, including byte-range seeking, with a 512 MiB transfer cap. The app does not buffer a complete video in the Node process for playback. Only up to three compressed timestamped frames per output go to the model (at most 64 frames across one call, sharing the existing 4 MP image budget); no original video or audio enters its context. These samples cannot establish continuous motion, a seamless join or the exact last frame. Browser codec support is required. History stores reduced frames and links; clearing it never deletes Comfy originals.

A stage label does not automatically change quality. This release does not implement universal draft-to-final latent reuse, video-source inputs, frame-overlap extraction or clip stitching. Those need the actual workflow input contracts; changing resolution with the same seed alone does not preserve a clip. The video tool is available only after a video workflow is registered and requires native tool support in the local LLM.

The wire formats follow [ComfyUI's video outputs](https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_video.py) and [VideoHelperSuite saved-video descriptors](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/blob/main/videohelpersuite/nodes.py); no workflow-specific node name is required for selecting the video output.


## Local model library

Place each model in its own subfolder of `models/`. The folder name supplies the initial display name: for example `models/My model/model.gguf` and `models/My model/mmproj.gguf`. The file `put model folders here.txt` explains this layout. Git includes the guide and ignores GGUF weights. Keep llama.cpp and its libraries separate; its path is shared across models.

Opening Configuration scans these immediate subfolders. Choose a detected folder and open **Chemins** and click its **Enregistrer** button to remember the name and paths, or click **Ajouter un LLM** to open the empty path editor, then save it. Saved pairs survive restart in `data/models.json`; no model file is moved. Detection requires exactly one main GGUF and optionally one projector whose filename contains `mmproj` (case insensitive). Both extension and GGUF header are checked. Ambiguous folders and invalid files are reported. Split GGUF shards and multiple quantizations in the same folder require separate handling and are not auto-selected. Matching headers do not guarantee that a projector is compatible with the chosen model.

With several saved models, use the selector in the bottom-left model card. Switching is blocked during chat or ComfyUI work, unloads the old model, and loads the new one if the engine was running. An idle engine remains stopped until the next message. Context, output and compute settings remain shared; choose values suitable for the selected model. The current conversation is retained. Manual path controls remain available after stopping the engine. Automatic updates preserve the models directory.


## Getting started

Requirements: **Node.js 22 or later**, a recent browser, and a **recent llama-server build with Qwen3.5 and vision support**, together with its native libraries. Choose a build that matches your operating system, architecture and hardware. The application does not download models or install dependencies automatically.

On Windows, double-click **Lancer-Windows.cmd**.

On Linux:

```sh
sh lancer-linux.sh
```

The same command also works on both systems:

```sh
node scripts/launch.mjs --open
```

Open **http://127.0.0.1:8787**. Keep the launcher window open; it stays attached through updates. Closing that window, pressing `Ctrl+C`, or choosing **Fermer l’application** in Configuration stops the app and its model and releases the port. Launching again reuses an existing Atelier instance. Another service using port 8787 is reported and left untouched. If the browser does not open automatically, enter the address manually.

There is no need to run `npm install`. You can also use `npm start`.

## Generation previews and reference traceability

History originals load only near the viewport and release their browser blobs when scrolled away. Output transfers and compression run sequentially, instead of keeping a whole batch of originals in memory. Saved gallery copies are read from disk on demand; unsaved copies stay in memory. Reference reading remains available after the Comfy generation limit, and empty or truncated answers are not marked as completed image reviews. Status polling cannot overlap; the loading animation pauses in a hidden tab.

The chat shows an animated organic frame while ComfyUI runs and replaces it with the original output as soon as it can be retrieved, including while the language model reloads. This original is only a browser display blob; only compressed analysis copies are sent to the model. Declared numeric dimensions determine the loading frame ratio when known. If dimensions depend on an unexecuted custom node, the preview starts square and adopts the original size when available. No custom node formula is guessed. Reduced-motion preferences stop the animation.

Resources have persistent `Ref 1`, `Ref 2`, … labels shared by the UI and the model catalog. Deactivating or deleting a resource does not renumber the remaining references. The native reading tool can inspect up to eight distinct resources together per turn. Temporary pixels are labeled separately and excluded from saved conversation messages. Generation records report the number of image references actually transmitted and the workflow's configured capacity; a text-only preset does not gain reference-image inputs from its description. Configure a suitable workflow before expecting reference pixels to reach ComfyUI.

The launcher sends a control heartbeat every ten seconds and retries a briefly interrupted connection. Closing its terminal still stops its own model and server after a short reconnect grace period. Existing saved chats and ComfyUI originals are preserved.


## Multiple ComfyUI references

When importing an API workflow, open **Entrées que le modèle peut modifier → Images de référence → Ajouter une entrée**. For each image input, choose its existing filename field in the graph, give it a name and a short role description, and mark it required if needed. Add as many separate inputs as the workflow supports (up to 64 for validation). Image roles and custom node types are not guessed. The workflow must already connect these inputs to its processing nodes; the app does not create connections, batch nodes or image mergers.

The native tool advertises the declared input IDs and descriptions. The model can map different chat images and active library resources (including a selected video frame) to these inputs in a single Comfy call. Missing required inputs, conflicting sources, duplicate target fields, inactive resources and unknown inputs are rejected. Each distinct compressed source is uploaded once, then assigned to the selected fields. Approval, GPU handoff and generated-image history apply to the complete call. Optional inputs retain their saved workflow value if omitted.

Existing single-reference workflows continue working without migration. Reimport a workflow to declare multiple image inputs. Prompt preselection and output detection still use the existing standard `CLIPTextEncode`/`SaveImage` heuristics in the import UI; the new image-input mapping has no node-class rules. Actual generation quality and multi-image support depend on the imported workflow.


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

The interface starts in **Night** mode. The **Day / Night** button is inside Configuration. Your choice is saved in `data/preferences.json` and restored after closing or restarting the application. This file stays local and is excluded from Git. The wider Configuration button sits below the model card. Settings open in a centered, rounded dialog; clicking outside or pressing Escape closes it.

Context and maximum output use discrete sliders with the same token presets. The output slider stays within the selected context; compute mode is below them. Empty path fields show a red **None** placeholder. The initial composer is centered with suggestions underneath; it moves to the bottom after a message. Surfaces share an original, locally generated 2048 × 2048 metallic texture. The texture stays static. Subtle pointer lighting on the composer and model card has no idle animation loop and respects touch and reduced-motion settings.

## Chat and images

The first message automatically starts the configured model and its vision projector, if provided. The message waits until loading completes, then sends once. Images can be attached before startup when a projector is configured. You can cancel the waiting message; its text and images return to the composer while model loading continues. A loading failure also preserves the message. Manual start/stop controls remain available.

- Type a message and press Enter. Shift+Enter inserts a new line.
- Attach PNG/JPEG images with the image button, by dragging them onto the composer, or by pasting an image into the message field.
- Attach up to 64 images per message, with a maximum of 64 MiB per source file. The browser prepares analysis copies with a maximum 1,024-pixel longest side and a shared four-megapixel budget. It keeps the smaller PNG or JPEG result; JPEG uses quality `0.82` and a white background. A conversation request remains limited to 20 MiB and 100 messages; start a new conversation when either limit is reached.
- **Réflexion** (Thinking) asks the model's chat template to enable or disable reasoning. Its effect depends on the model. Received reasoning appears in a separate collapsible section.
- The square button interrupts the current response. Text already received is kept.
- **Contexte total** is the shared window for messages, image tokens, reasoning and the reply. **Sortie maximale** independently limits generated tokens per reply, including reasoning: 4,096 by default, with choices up to 32,768 within the selected context. The interface reports a response cut short by an output or context limit. Stop the model before changing these settings, then save; they apply on its next start.
- Model replies render common Markdown: headings, paragraphs, bold and italic text, strikethrough, lists, quotations, simple tables, links, and inline or fenced code. Formatting updates while the reply streams. Raw model HTML is escaped, unsafe link protocols are rejected, and embedded image syntax does not load remote images.


Only block quotations and fenced code blocks have a small copy icon at the top right. Its own column reserves space so it cannot overlap text. Quotations copy their plain text; code copies exclude language labels and fence markers. Ordinary replies have no global copy button. Clipboard failures are reported. The transcript and composer share one responsive width, accounting for the scrollbar. Short fades and subtle blur soften the top and bottom of the scroll area.

A small context meter below the composer shows the current conversation plus draft, the configured context size and the reserved reply ceiling (including reasoning). The reply ceiling is a limit, not a guaranteed allocation. Counting waits until typing pauses and never starts an idle model. Compatible engines count the actual chat input, including tools and images, without generating a response. Older engines use their text template/tokenizer: **≈** marks an estimate and **≥** marks text-only counting with unknown extra image cost. If counting is unavailable, **—** is shown. Warnings appear as input plus the reply ceiling approaches capacity; messages and settings are never silently reduced.

Closing modified Configuration asks whether to save, keep editing or discard changes. This covers the close button, Escape and outside clicks, with a browser warning on page closure. Theme/history preferences are already saved immediately and do not produce this warning. Finish or skip an incomplete workflow import before saving the main form.

## Shared resources and Output

The floating panel on the right has **Ressources** and **Output** tabs. Each tab scrolls independently; the resource grid adapts to the number of items. On narrower screens, the panel moves below the chat.

Drop PNG/JPEG/WebP images or MP4/WebM videos into Resources, or use its file chooser. The app copies them into ignored **data/resources/** and keeps compressed analysis copies alongside them. The library survives conversation changes, history deletion and app restarts, even when chat history is off. The trash button appears on hover or keyboard focus and stays visible on touch devices. Deleting removes the app's copies, never the file originally chosen on your computer or any original ComfyUI output. Limits are 64 MiB per source image and 512 MiB per video.

New resources start active. Their individual switches and short descriptions (300 characters maximum) persist. Descriptions save when leaving the field and are flushed before a chat message is sent. Unsaved descriptions trigger a page-close warning. Inactive resources remain visible to you but are excluded from the model's current catalog and visual lookup tool. Past conversation text is retained.

For context efficiency, each request gets a compact text catalog of active resources. Visual copies are fetched only when the model issues the native **local_read_resource** tool call. Those copies are used within that turn and excluded from saved chat snapshots and future turns. Previous textual analysis remains in the conversation. This requires a vision projector and a model/template supporting native tool calls; text-only models can still use the annotations. No keyword rule forces generation or resource lookup. A compatible Comfy image-input workflow may also use an active resource as its reference, under the existing approval policy.

Videos are preserved for normal local playback but are shown to the model through **up to three compressed frames at 10%, 50% and 90% of their duration**, with timestamps. This does not provide continuous motion analysis or audio. Browser codec support is required to prepare the frames. Video playback streams local byte ranges rather than loading the entire original into JavaScript memory.

Output follows the current conversation and its existing history preference. Cards show a preview, workflow and an expandable prompt. **Details** opens the original image with the complete prompt, workflow, date, seed, original resolution and available execution parameters. New runs also retain the Comfy job identifier, workflow digest, measured Comfy duration and bounded scalar workflow inputs when available. Missing values are not guessed; if ComfyUI or its original is unavailable, the viewer identifies the compressed fallback. Original ComfyUI files remain under ComfyUI's control.

## Local image generation with ComfyUI

ComfyUI tools are **disabled by default**. Run your own local ComfyUI instance, then open **Configuration → ComfyUI**, enable the connection and enter its API address. The default is `http://127.0.0.1:8188`; a Comfy backend used through SwarmUI may use another local port, such as `http://127.0.0.1:7821`. Use the backend's actual API address. The application does not install ComfyUI, download models or bundle third-party workflows.

Export a copy of your workflow from ComfyUI using **File → Export (API)**, enabling developer options if necessary. Import this **API-format JSON** in Configuration. Ordinary editor workflow JSON, including complex subgraphs, must be exported through ComfyUI first; the application does not convert it. Imported copies are saved under ignored `data/workflows/`; your original workflow is untouched. Set a name and description, identify the saved-image output nodes, and provide explicit node/input bindings for the required `prompt` and any supported `negative_prompt`, `seed`, `width`, `height` and `image`. Mark image-editing workflows that require a reference. The model can change only these mapped inputs. Width and height must be multiples of 8 between 64 and 4,096; a seed must be a nonnegative safe integer.

Use a **GGUF model and chat template that support native tool calls**. The application supplies the tools and starts llama-server with `--jinja`; no extra manual engine flag is needed. A text imitation of a tool call does not execute a workflow. For workflows with an image binding, the model can select a supplied reference using its zero-based index.

Every execution asks for permission by default. You can approve once or allow imported workflows globally, then revoke that setting in Configuration. The default limit is **five generations per user turn**, adjustable from 1 to 9,999 or **∞** (10,000 internally). The approval names the workflow and parameters; progress and cancellation stay visible. Restoring a conversation never silently replays an approval or starts a pending job.

During a run, the application waits for ComfyUI to be idle, unloads the chat engine and its vision projector, then runs the approved workflow. It frees ComfyUI's models before restarting the chat engine and projector for review. The local ComfyUI service stays running. Only compressed analysis copies go to the vision model; it compares them with the instruction and references and can revise within the iteration limit. Its review can miss details lost in compression and does not train the model. The **right-hand gallery** shows workflow and prompt details and lets you view or download the original ComfyUI output.

ComfyUI is detected by checking the saved address and the usual local ports 8188 and 7821, without a port scan. A detected address stays visible and read-only; **Modifier** enables manual entry. **Tester la connexion**, next to the address label, checks the address currently displayed. **Enregistrer** saves both model and ComfyUI settings and closes the dialog; there is no separate ComfyUI save button. ComfyUI-only changes can be saved while the chat model is running.

The generation counter has −/+ controls and an **∞** option (a backend ceiling of 10,000 attempts). Context, message and memory limits still apply. **Ajouter des workflows…** accepts multiple API JSON files and asks for a description for each one. Descriptions can also be edited in the workflow list and saved with the main buttons. The model receives all registered names, descriptions and supported inputs, and is instructed to select the most appropriate workflow.

## Optional conversation history

**Conserver les conversations** in Configuration is on by default. When off, messages stay in page memory and are lost on closure or reload. When enabled, the application saves messages, reasoning and copies of the browser-compressed images under `history/<conversation-id>/` in the project folder. Each conversation has `conversation.json` and content-addressed image files; repeated saves reuse the same image bytes. Both `history/` and `data/` are excluded from Git. When uploading sources manually, exclude both folders yourself.

Saved conversations appear in the sidebar, or inside Configuration on narrow screens. Reopen one to restore messages and images and continue chatting. Pending user turns, periodic partial replies and finished replies are saved. An unfinished user turn is restored as an editable draft and is never resent automatically. A restored partial assistant reply is marked as partial. A forced shutdown can still lose the latest unsaved part of a streamed reply.

Current and saved conversations share one stack of equal-height rows. The current conversation stays first and highlighted; older conversations use a quieter style and show their date. Previously saved history and generation-limit choices remain in effect.

A trash button appears on each saved conversation when hovered or focused with the keyboard; it stays visible on touch devices. After confirmation it deletes only that conversation, its compressed copies and its gallery links. Original ComfyUI output files remain at their location.

Generated-image history keeps compressed review copies and gallery metadata/links only. Originals remain in ComfyUI's output storage. **Supprimer l’historique** deletes the saved compressed copies and links along with the conversation; it leaves original ComfyUI files unchanged. With history off, gallery records stay in page/server memory only.

Disabling history stops further writes and hides the list; it does **not delete** existing files. The red **Supprimer l’historique** button permanently deletes saved conversations and their images after confirmation, even when saving is disabled. It also closes the displayed exchange while keeping the current composer draft. The saving preference is retained; future exchanges can be saved again. Enabling it during a conversation saves the current exchange. Files are ordinary local files, grow as conversations accumulate, and can be backed up or removed manually while the app is closed. History does not increase the model's active context window: reopening an archive sends its restored messages only when you submit a new prompt, with the same context and request-size limits. Saving failures are reported and keep the conversation in the page; switching to another conversation is blocked until saving succeeds or history is disabled.

**Nouvelle conversation** preserves saved exchanges. With history off, it asks before clearing an existing conversation. Reloading the page does not unload the model: use **Arrêter le modèle** or stop the server. The model-card border is green when ready, red when stopped or unavailable, and amber while loading or stopping; its accessible label also reports the state.

## Memory and hardware

The default context is **8,192 tokens**, with all available model layers requested on the GPU. Context choices range from 4,096 to 262,144 tokens; the largest choices are advanced options, not a guarantee that a machine or a different GGUF model supports them. The Qwen3.5-9B base model declares a native context of 262,144 tokens ([model documentation](https://huggingface.co/Qwen/Qwen3.5-9B)), while available RAM/VRAM and the engine determine practical capacity. The initial profile targets a 12 GB graphics card, but actual memory use depends on the model, context and images. If the engine reports insufficient memory, stop it, then reduce the context or select fewer GPU layers in Configuration.

**CPU uniquement** (CPU only) runs inference on the processor and disables GPU offloading for the vision projector. It may be much slower. Windows/Linux support does not mean that every computer has enough memory for a 9B model. A machine without NVIDIA hardware can use a CPU engine or a llama.cpp build suited to its GPU.

The application does not apply or modify GPU unlocking tools. Startup, shutdown and update lifecycle smoke tests run on Windows and Ubuntu in GitHub Actions; hardware and model compatibility still depend on the selected engine.

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

## Update notification

At each launch, one background request checks the public version in this GitHub repository. It times out after four seconds without blocking startup or chat; offline checks remain silent. A light-blue button appears to the right of Configuration only when a newer stable version exists.

**Clicking the button installs the update automatically.** The app downloads a source archive pinned to a GitHub commit, checks its version and paths, backs up the sources it replaces, stops the idle model and restarts on the same address. The page restores the conversation, partial-response state, generated-image links and composer draft. Generation or another active operation must finish first. If download fails the current page remains usable; if the replacement cannot start, the previous sources are restored and restarted.

The installer preserves `data/`, `history/`, model weights, ComfyUI originals, Git metadata and files outside the managed source folders. A temporary session checkpoint is kept in `data/update-session.json` until the page restores it, even when regular history is off. Source backups and restart logs remain under `data/updates/`; install status is in `data/update-status.json`. Custom edits inside managed source folders are replaced, with their previous copies retained in the backup. Git metadata is not moved to the downloaded commit. No Git installation or npm dependency download is required. The project folder must be writable.

Maintainers: increase `version` in `package.json` for each public update, then publish it on `main`. Equal, older and preview versions do not trigger the button. Version checks and downloads send no messages, images, configuration paths or hardware details.

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
