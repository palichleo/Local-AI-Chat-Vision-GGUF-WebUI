# Native workflows replacing ComfyUI

Status: proposed design for review, before product implementation. Work stays on `prototype-runner`; `main` and the existing installation's data remain unchanged until the replacement is verified.

Builder review: an independent review found no important unanswered planning question. Native LongForge checkpoint compatibility, GPU memory and media behavior remain explicit execution-validation risks, not assumptions of success.

## Intent

Turn the successful rough Python runner into Atelier's local generation engine. Users configure image/video workflows in the existing browser interface. The LLM discovers workflows by their user-written description, proposes tool calls using only permitted parameters, and reviews compressed outputs. Original media remains accessible to the user. ComfyUI is no longer required for executing the supported workflows.

The first supported families are the validated Krea2 image pipeline and the user's **LongForge LTX2.5** video workflow. Model filenames must remain configuration data, never executable-code constants. Explicit family-specific implementations and architecture definitions are legitimate; pretending to run arbitrary model families is not.

## Approaches considered and selected recommendation

1. **Native family pipelines + a small declarative JSON format, reusing Node's application and tool loop.** Recommended: retains proven UI/history/permissions while replacing execution. Each pipeline declares actual capabilities, validates compatible components and resolves a complete immutable job before loading models. This follows the user's request for a simple syntax and optimal native execution.
2. A general-purpose graph/node interpreter: rejected because it recreates Comfy complexity, custom-node dependencies and arbitrary execution semantics instead of the requested simple workflows.
3. Embed or continue calling Comfy internally: rejected because it retains the dependency the user wants removed.

There is one sensible architecture within these constraints. The remaining builder choices are module/function names, exact layout spacing and how low-level native kernels are packaged; they must not change the behavior below.

## Existing code to retain

`lib/tool-runtime.mjs` already sequences authorization, LLM/projector unload, one generation, output persistence, generator unload and LLM/projector restart. It already forces explicit approval for every video. `lib/resources.mjs`, the gallery/history, generation previews and native tool transcript should retain their behavior.

The Comfy-specific catalog, transport, discovery, graph bindings and original-media proxy must be replaced with native equivalents. Rename public-facing tools to generation-provider-neutral names and migrate old stored transcripts without replaying tools. Avoid a parallel second implementation of permissions, resources or video approval.

Launch currently has one Node supervisor reached from Windows batch and Linux shell launchers. That supervisor can start a Python child, without another console, unmanaged process or listening port. Source fingerprinting and automatic updates must include the new tracked Python modules; user workflows, weights, caches and outputs must remain preserved.

## Separation of responsibilities

- **Node application:** owns configuration/UI persistence, workflow catalog, asset registry, tool schemas, authorization, history, original-media access and the process lifecycle. It resolves user/LLM policies before dispatch.
- **Python worker protocol:** JSON-line stdin/stdout with version/ready handshake, request and job IDs, progress, success/error/cancellation, diagnostics and explicit GPU release acknowledgment. Logs go to stderr. No arbitrary Python path, shell command, expression or module name is accepted from JSON.
- **Workflow validation/resolution:** shared contract checked at the Node boundary and independently by Python. Resolve every policy once into concrete values. Generate a random seed once per job, save it and reuse it for retries; never recompute it silently after approval.
- **Model/component loading:** supported family and checkpoint-layout inspection, compatible local asset IDs, bounded CPU/GPU residency, LoRA preparation/cache invalidation, capability reporting and release. No hidden downloads.
- **Image pipeline:** Krea2 prompt encoding, optional expansion, image-to-image, sampling and decoding. Preserve the validated INT8 path, tuned kernels and measured fallback options.
- **Video pipeline:** LTX2.5 encoding, sampling, video/audio VAE handling, conditioning/reference roles and temporal rules.
- **Video sequence orchestration:** scenes, source clips, overlap, segment identity, draft/final lineage, continuation and export. This is distinct from a model forward pass.
- **Media/export:** original PNG/MP4/WebM and metadata, compressed analysis copies, thumbnails and safe paths. Resolve required encoder/FFmpeg availability explicitly.

Move maintained code out of `experiments/` into a focused `runner/` Python package. Keep experiment reports as references, not runtime imports. Small modules by responsibility; no universal plugin framework or invented graph language.

## Workflow files and local assets

Use a project-root **`workflow/`** folder, as requested, with one versioned JSON file per workflow. Publish a folder guide and generic examples; ignore user workflow files, absolute paths, checkpoints, prepared weights and generated media. Shipped examples/templates live separately in tracked runner assets and are copied on explicit creation, so updates cannot overwrite edited workflows.

A workflow contains stable ID, editable name, description, enabled state, `schemaVersion`, pipeline family, output type, selected model/components, parameter definitions/policies, LoRAs, reference-role slots and optional video profiles. IDs are opaque and independent of display names.

Model/encoder/VAE/LoRA selections refer to local asset IDs resolved by a registry. Paths can be edited or browsed from the UI, and candidate assets may be discovered in user-configured folders. Inference must inspect and reject incompatible checkpoint layouts before stopping the LLM. A list of filenames alone does not prove compatibility. No option silently downloads a replacement.

Illustrative syntax; exact schema names can be tightened in the implementation plan:

```json
{
  "schemaVersion": 1,
  "id": "local-image-preset",
  "name": "My image workflow",
  "description": "When the LLM should choose this workflow",
  "enabled": true,
  "pipeline": "krea2",
  "mediaType": "image",
  "components": {
    "model": {"policy": "fixed", "asset": "asset-model-id"},
    "textEncoder": {"policy": "fixed", "asset": "asset-encoder-id"},
    "vae": {"policy": "fixed", "asset": "asset-vae-id"}
  },
  "parameters": {
    "prompt": {"policy": "model", "type": "string", "maxLength": 8000},
    "seed": {"policy": "random", "type": "integer"},
    "width": {"policy": "fixed", "value": 1448},
    "height": {"policy": "fixed", "value": 1448},
    "steps": {"policy": "fixed", "value": 8}
  },
  "loras": [
    {
      "id": "style-one",
      "asset": "asset-lora-id",
      "description": "Effect and appropriate use",
      "enabled": {"policy": "model", "default": true},
      "strength": {"policy": "fixed", "value": 0.55}
    }
  ],
  "references": [{"id": "source", "role": "img2img", "required": false}]
}
```

### Who controls a parameter

- **Fixed / Verrouillé:** the user selects a value; it is absent from writable LLM tool arguments. Attempts to override it fail server-side.
- **Model / Au choix du modèle:** expose only configured choices/ranges supported by the pipeline, with a description. The LLM never chooses arbitrary files, Python classes or unsupported components. Model selection can only range over explicitly compatible user-allowed assets; normally keep it fixed.
- **Random / Aléatoire:** available for seeds only. Resolve securely once, store the concrete seed in output metadata and approval plans. A fixed seed is replayable; random is not a synonym for “LLM chooses”.
- **Off / Désactivé:** a LoRA is never loaded or applied. Distinguish this from model-controlled enable/disable and from fixed enabled strength. Enablement and strength have independent policies. Enforce configured numeric bounds, including negative strengths only where explicitly supported.

The UI should offer these policies where they are meaningful, using compact segmented controls and a value field, rather than exposing internal schema jargon. Validation is authoritative even if a tool call bypasses the UI. Configuration edits invalidate pending approvals/jobs based on a canonical workflow digest.

## Settings and workflow editor

Replace the Comfy block with **Workflows**. Keep enable generation, image auto-authorization and per-message generation limit. Replace server-address discovery with runner status and Python environment configuration/diagnostics.

**Add workflow** opens an editor in the **same centered rounded panel footprint** as Settings. Swap panel contents with a short transition; the parent view is preserved, not visible as a second competing modal. A back control returns to Settings. Editing an existing workflow opens the same editor.

Editor order: name/description and image/video pipeline, model components, generation parameters with ownership policies, LoRAs, reference roles, and video-only controls. Show only supported fields. LoRA rows expose asset, short purpose, enable policy and strength policy/value. Use existing native file-picker UX with current compatibility feedback.

The editor's **Save workflow** atomically saves its JSON, validates assets/settings and returns to the workflow list. Dirty-state handling covers back, backdrop and close; Escape and focus restoration behave like existing settings. Parent settings save continues to save application settings. Nothing is inferred saved merely from closing the editor. Invalid data stays visible with an inline actionable error and never removes the existing valid workflow.

Support importing/exporting this native format and creating from available pipeline templates. The existing Krea Comfy graph gets a one-time, explicit supported conversion with a backup. Do not advertise automatic conversion of arbitrary editor/API graphs. Unknown graphs report unsupported nodes/families and remain untouched.

## LLM tool behavior and GPU ownership

Generate tool schemas/catalog descriptions from enabled, ready workflows and their writable policies. Preserve resource IDs, named reference roles, iteration limits and output review. An ordinary request to write a prompt must not imply generating media. When generation is disabled/unavailable, do not advertise runnable generation tools.

At launch start the Python process on CPU so imports/diagnostics can warm up. Do **not** load large model weights onto the GPU at UI startup. Missing Python/packages leave chat usable with a generation diagnostic; no automatic installation. Resolve the configured interpreter first, then normal local Python discovery; no shipped personal path or dependency on Swarm's installation.

Execution sequence: validate complete job and authorization -> stop LLM/projector and confirm release -> acquire generation GPU lease -> load/run -> persist originals/result -> release generator models and confirm -> reload LLM/projector -> review compressed output. The CPU worker can stay open throughout. This keeps the measured warm-worker benefit while honoring the 12 GB VRAM constraint.

One job at a time. Cancellation must stop active work and reach a known released state; between diffusion steps, check cancellation, and where inference cannot cooperate promptly, terminate the owned worker and restart it cleanly. A hard worker crash/OOM cannot leave the chat reporting a model ready when it is not. Never stop unrelated user processes. Launcher exit, update and server shutdown close the owned child and reap it on Windows/Linux.

## Video scope: LongForge LTX2.5

Source inspected: user's editor JSON **LongForge LTX2.5**, including its model subgraph. It uses a 22B distilled INT8 ConvRot transformer, Gemma4 12B text encoder with projection, separate video/audio VAEs, optional enhancer and MSR LoRA references. These filenames remain private conversion inputs. Main local checkpoints appear present; inference outside Comfy has not been validated.

The workflow includes scenes, duration/resolution, optional source video, optional MSR image references, video/audio generation, sampling sigmas, overlap/continuity and export settings. The installed Diffusers includes LTX2.5-aware components, but this alone does not establish checkpoint, quantization or LongForge behavior equivalence. In particular, Gemma4 12B cannot simply be fully expanded on the 12 GB GPU.

Native video implementation must inspect the local LongForge/MSR code as reference behavior and implement/verify the needed math and sequencing without importing Comfy or silently invoking it. Reuse independently packaged libraries if appropriate; do not copy a custom-node package wholesale without checking its license. Keep the source workflow unchanged. Do not copy its saved scene text or original media filenames into shipped public templates.

Video profiles support explicit **draft** and **final** presets. Store prompt, concrete seed, chosen components/LoRA states, references and stage lineage. Promoting a draft keeps those concrete inputs and changes only approved quality settings. A seed alone does not ensure identical motion at another resolution; show what was preserved and allow review.

Reference roles include start image, end image, MSR/reference image and source video **only where implemented by that pipeline**. Continuation names a source segment/output, selected tail/overlap and temporal/audio policy. Resolve frame counts, cadence, latent alignment, overlap and audio time base using the pipeline's validated temporal rules; do not assume arbitrary universal values. Required assets/roles cannot be silently ignored.

Before **every video execution**, show the concrete proposal, explicitly draft/final, prompt/intent, references, duration, resolution, cadence, seed, workflow and continuity choices. Require a single-use explicit approval token tied to the resolved job digest, even when images have global authorization. Editing the proposal invalidates approval. Changes required after memory preflight require a new proposal, never an unannounced lower quality setting.

Deliver in validated increments: short native clip, reference-conditioned clip, draft/final promotion, continuation/overlap, then multi-scene/audio/export cases present in LongForge. A video capability is exposed to the LLM only once its executor is implemented and tested; unavailable features stay disabled with their reason. Final replacement is not considered complete until the agreed LongForge cases actually execute successfully.

## Outputs, persistence and migration

Write original generation media to project **`output/`**, with an editable local output location if needed, independent of conversation `history/`. Keep metadata/manifest alongside originals: workflow digest/version, resolved inputs, concrete seed, selected assets/strengths, timing, resolution, video stage/lineage, cadence/duration and references. The user sees originals; the LLM receives bounded compressed images/video samples as today, with clear analysis limitations.

Deleting conversations/history removes compressed analysis media and links, **never originals** in `output/` or outside the project. Deleting a resource preserves original generation files. History-off mode does not accidentally persist chat analysis. Original-media HTTP routes allow only registered manifests under approved roots, not arbitrary requested filesystem paths.

Back up old Comfy config and workflow metadata. Old historical output descriptors remain historical; do not replay them. Where an existing original local path can be verified from its configured output root, preserve access by registering it without relocating/deleting the original. Otherwise show the old link as unavailable with a clear status; do not fabricate previews or require Comfy for new generation. Keep compressed historical media readable.

Track Python sources in automatic update/fingerprint lists. Preserve user workflow, asset registry, output/cache/config directories through update/rollback. Publish no model weights, prepared caches, personal filesystem paths, generated user scenes or media.

## Verification and completion

- Contract tests for strict JSON validation, versions, fixed/random/model/off policies, allowlists, seed reproducibility, ranges and digest invalidation.
- Worker lifecycle tests for startup/handshake, missing environment, error recovery, cancellation, GPU-release acknowledgment, crash, EOF, supervisor/update shutdown and no orphan child.
- Runtime tests for image/global permissions, mandatory video proposal approval, references, generation limits, progress replacement/error removal, restore LLM and truthful capability advertisement.
- UI smoke checks for same-size editor navigation, dirty state, save/reopen, native file browsing, missing/incompatible model feedback and keyboard/focus behavior.
- Persistence/update tests that deleting history preserves original files and updates preserve user workflows/assets while shipping new Python sources.
- Real Krea image/img2img comparisons against existing runner speed/quality, measuring warm and cold paths and all processes released afterward.
- Real LongForge LTX2.5 tests with local checkpoints: short video, reference roles, audio if enabled, stage lineage and continuation. Record unsupported behavior and failures instead of declaring parity from a successful import.
- Windows is the available real inference environment. Linux must retain launch/protocol/path compatibility and CPU smoke checks; no Linux GPU performance claim without that hardware.

## Decisions needing user review

The recommended architecture and policy semantics above implement the stated request. Builder calls to review: same-panel editor navigation, native family pipelines instead of an arbitrary graph engine, project `workflow/` + `output/`, CPU-only warm startup, and sequential validation of LongForge features before advertising them. The requested video reference is now identified; no further missing path is required to prepare the implementation plan.
