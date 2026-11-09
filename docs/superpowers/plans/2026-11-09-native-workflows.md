# Native Workflow Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the coordinated implementation, task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace Comfy generation with validated native JSON workflows, a supervised Python engine and a same-panel workflow editor.

**Architecture:** Node retains tool permissions, resources, history and supervision. A versioned declarative catalog resolves policies into immutable concrete jobs dispatched by JSON-line protocol to family-specific Python pipelines. Implement/test image first, then validate LTX2.5 capabilities before advertising video tools.

**Tech Stack:** Node 22+, HTML/CSS/JS, Python 3.13 locally, installed Torch/Diffusers/Transformers/Accelerate/Safetensors/Pillow/Triton/comfy-kitchen. No downloads or automatic installs.

**Spec:** `docs/superpowers/specs/2026-11-09-native-workflows-design.md` (approved by user).

## Global Constraints

- Work on `prototype-runner`; preserve `main` and original Comfy workflows/media.
- No hardcoded checkpoint filenames/personal paths; family architectures may be explicit.
- Project `workflow/` and `output/` are user data, excluded except folder guides.
- Worker starts CPU-only and generation errors cannot disable ordinary chat.
- Every video needs explicit single-use approval of the resolved concrete job.
- Preserve original media on history deletion and preserve user data on updates.
- Native checkpoint/feature support must be demonstrated, not inferred from filename/import.

## Review Focus

- Fixed/random fields cannot be changed via direct model tool calls; random seed resolved once across approval and execution (Task 1/4).
- Owned Python dies or cancellation interrupts during model load: confirm GPU release before LLM restart and reap child (Task 3/4).
- Invalid/incompatible asset edits cannot replace a saved valid workflow (Task 1/5).
- Old chat/output descriptors must load without replay and without history deletion removing originals (Task 4).
- Missing optional video models/audio/temporal constraints must reject jobs before advertising an executable capability (Task 7).

## Interface contract

Workflow JSON follows the approved schema: `schemaVersion:1,id,name,description,enabled,pipeline,mediaType,components,parameters,loras,references,profiles?`. Component policy is `{policy:'fixed',asset:id}` or model policy with explicit `choices/default`. Primitive parameter policy is fixed `{value}`, random (seed only), or model `{type,default,min,max,choices,maxLength}`. LoRA records have stable id, asset id, description, enabled policy (fixed boolean/off/model), strength policy. Pipeline schemas impose supported fields and ranges; JSON cannot name modules or execute expressions.

Resolved job: `{schemaVersion:1,id,pipeline,mediaType,workflowId,workflowDigest,parameters,components,loras,references}`. Components map roles to absolute local paths resolved from registered assets; LoRAs are `{id,path,strength}`; references are `{input,role,path}` after reference staging. Python revalidates values and checkpoint layouts. Output root/cache/tokenizer configuration is passed by trusted worker startup configuration, not arbitrary tool arguments.

Worker protocol v1 requests `{id,method,params}` with methods `diagnostics`, `preflight`, `generate`, `release`, `shutdown`. Responses `{id,result}` or `{id,error:{message,code}}`; progress `{event:'progress',id,data}`; ready `{event:'ready',protocol:1,capabilities}`. Generate resolves only after GPU cleanup; result `{jobId,outputs:[{filename,subfolder,type:'output',width,height,...}],metadata}`. Stdout is JSON only; dependency logs go to stderr. Cancellation kills/reaps the owned worker if cooperative interruption cannot be confirmed.

Node `GenerationWorker`: `start(config)`, `status()`, `request(method,params,{signal,onProgress})`, `release()`, `close()`. No additional listening socket. Native tool runtime reuses permission/resource/VRAM transitions; legacy Comfy code is retained only as compatibility/migration machinery, not the UI's default provider.

## Task 1: Native catalog, assets and policies

**Files:** `lib/native-workflows.mjs`, `lib/generation-assets.mjs`, `tests/native-workflows.mjs`, `tests/generation-assets.mjs`, `runner/templates/*.json`, `workflow/PUT WORKFLOW FILES HERE.txt`, `.gitignore`.

**Interfaces:** `validateNativeWorkflow(input)`, `resolveNativeWorkflow(workflow,args,assets,{seed,jobId}) -> job`; `NativeWorkflowCatalog(directory,{assets}).list/read/save/remove/prepare/toolDefinition`; `GenerationAssets(file).list/register/read/resolve`. Expose metadata without arbitrary executable code. `catalog.kind='native'` and prepare returns `{workflow,job,outputNodes:[]}`. Tool definitions use `generate_image`/`generate_video` and writable policy fields only.

- [ ] Write policy/asset tests first: locked override rejection, bounded model enum/range, seed resolved once, disabled LoRA omitted, corrupted catalog entry isolated, file validity and atomic saves.
- [ ] Observe failing tests; implement schema, safe asset registry and canonical digest.
- [ ] Run Node targeted tests and commit this deliverable.

## Task 2: Maintained Python image pipeline and strict protocol

**Files:** `runner/__main__.py`, `runner/protocol.py`, `runner/contracts.py`, `runner/pipelines/krea2.py`, `runner/models/{text,weights,kernels}.py`, `runner/media.py`, `runner/tests/test_*.py`.

**Interfaces:** `validate_job(job)`, `preflight(job,config)->capabilities`, `generate(job,config,progress)->result`; explicit pipeline map only. Retain existing validated optimized/tuned algorithms but remove graph parsing/runtime imports from experiments. `python -m runner --config PATH` starts handshake CPU-only, serial requests and cleanup. Krea parameters support prompt, seed, dimensions, steps, cfg=1, denoise, optional prompt expansion/ref image; model/encoder/vae paths come from resolved job. Tokenizer path comes from config.

- [ ] Write independent Python job/protocol tests, run and observe failures.
- [ ] Refactor existing image implementation by responsibility; strict validation and actual checkpoint-header compatibility preflight.
- [ ] Test CPU protocol/missing deps/failure cleanup; run real native image with existing local assets after integration. Commit maintained pipeline.

## Task 3: Node worker supervision and startup/update lifecycle

**Files:** `lib/generation-worker.mjs`, `tests/generation-worker.mjs`, `tests/fixtures/fake-generation-worker.mjs`, `server.mjs`, `lib/app-sources.mjs`, `lib/update-archive.mjs`, launcher/update tests.

**Consumes:** Task 2 protocol. **Produces:** `GenerationWorker` contract above; diagnostics persist even if start fails. Worker config contains tokenizer, cache root and output root, not model weights. Interpreter uses explicit configured path, environment override or system python candidates; never a personal path fallback.

- [ ] Add fake-child tests first: bounded handshake, bad JSON, request routing, progress, abort/kill/reap, close/EOF, restart and missing interpreter.
- [ ] Implement lifecycle; start worker during normal application launch CPU-only without delaying chat on failure.
- [ ] Include runner sources in update/fingerprint but exclude user dirs; verify targeted launcher/update tests and commit.

## Task 4: Native tool runtime, outputs and migration

**Files:** `lib/tool-runtime.mjs`, `lib/generated-media.mjs`, `lib/comfy-gallery.mjs` (history compatibility), `server.mjs`, `tests/native-generation-integration.mjs`, tool/history tests.

**Consumes:** Tasks 1–3, existing resources/Engine. **Produces:** generation HTTP APIs `/api/generation` GET + config POST, `/api/generation/workflows` GET/POST, `/api/generation/workflows/:id` GET, `/api/generation/remove` POST, `/api/generation/assets` GET/POST, `/api/generation/test` POST. Bootstrap adds `generation`, `runner`, `nativeWorkflows`; native tool calls use existing approval/status/result events. Original output descriptors map to registered local root/manifest; history data may retain legacy Comfy descriptors.

- [ ] Write failing integration tests for fixed/random policy through approval, references, LLM unload-before-generate, generator release-before-restart, cancel/error, and video token requirements.
- [ ] Adapt shared runtime to native prepared jobs while retaining legacy unit-test path; new UI never depends on Comfy discovery.
- [ ] Add original-media safety tests and legacy migration backup tests; history deletion never removes originals. Verify and commit.

## Task 5: Same-panel workflow settings editor

**Files:** `public/native-workflow-ui.mjs`, `public/index.html`, `public/styles.css`, `public/app.js`, `public/settings-guard.mjs`, `tests/native-workflow-ui.mjs`.

**Consumes:** Task 4 APIs and Task 1 schema. **Produces:** `setupNativeWorkflows({api,state,notice,...})` with `refresh,values,workflowDescriptions,setBusy,hasPendingImport` compatible hooks as needed, preserving existing generation event handling. Replace user-facing Comfy block with native Workflows. Same dialog switches between main settings and editor, with back/save/dirty focus handling. Python path/tokenizer diagnostics in engine settings. Model/VAE/encoder selectors use registered assets/native browse. LoRAs have separate enabled/strength policies. Native imports and Krea conversion validate before saving.

- [ ] Add failing DOM/logic tests for editor policy controls, save/reopen, incompatible edits and dirty navigation.
- [ ] Implement family-driven UI and same-footprint navigation; keep global settings search/guard correct.
- [ ] Smoke keyboard/layout/API flow in available browser; commit verified editor.

## Task 6: Native Krea migration and real image verification

**Files:** `runner/convert_krea.py` (one-time supported conversion), migration API/tests, local ignored config.

- [ ] Test conversion rejects unknown graphs, preserves seed/LoRA state/strengths, backs up source and never overwrites original.
- [ ] Convert actual local Krea registration explicitly within experimental installation; real text/image tool roundtrip, timings and GPU handoff. Close owned processes.
- [ ] Record measurements/remaining limits; commit conversion/docs.

## Task 7: LongForge LTX2.5 native video execution

**Files:** `runner/pipelines/ltx25.py`, `runner/models/ltx25.py`, `runner/video/{timeline,references,export}.py`, `runner/convert_longforge.py`, pipeline tests/templates/capabilities.

**Consumes:** Installed Diffusers LTX2.5 components, local user workflow/custom-node reference behavior; no Comfy runtime import. **Produces:** real LTX2.5 capabilities after validated checkpoints and short inference: draft/final, start/end/MSR refs, source-video continuation/overlap, multi-scene/audio/export where proven.

- [ ] Inspect exact local transformer/Gemma/VAE formats and LongForge timebase; write numerical/contract tests before converters and timeline logic.
- [ ] Implement bounded model loading for 22B DiT/Gemma12B, checkpoint remapping, VAE/audio/export. Reject unsupported/missing optional components explicitly.
- [ ] Run short actual clip before advertising video; then reference, draft/final, continuation/overlap and multi-scene/audio validation. Do not weaken fixed parameters to make tests pass.
- [ ] Keep approved digest/seed/lineage across phases and record per-case evidence. Commit only truthful capabilities.

## Task 8: Whole-product checks and review

**Files:** docs/README translations, distribution/requirements/setup instructions, tests/final reports.

- [ ] Run all Node/Python suites, UI smoke, launcher cleanup, update/rollback preservation and real media roundtrips.
- [ ] Review whole change in a fresh context; fix critical/important findings with regression checks.
- [ ] Publish no paths/weights/user scenes; record exact image/video limitations, close owned instances and push `prototype-runner`. Do not merge `main` without user instruction.

## Execution ledger

2026-11-09: User approved design with “go”. Existing linked worktree verified on `prototype-runner`. Native execution selected by coordinator to preserve the ongoing session; independent domain work may be dispatched only with precise interfaces and non-overlapping file ownership under the parallel-dispatch skill. No repeated design permission is required for the approved scope.

2026-11-09: Tasks 1–6 implemented. Native catalog, policies, assets, Python image modules, worker lifecycle, Node tools/media and editor are connected. Full Node suite: 440 tests, 439 pass, 1 existing skip. Python: 18 pass. Browser smoke: settings load, same-panel editor and unsaved/discard navigation verified. Browse route mismatch corrected. Additional lifecycle regression verifies close during handshake cannot leave a late worker. Update/fingerprint checks include Python while preserving workflows/output/cache.

Actual Krea2 smoke on the local RTX 4070 Super: 512²/8 steps 17.10 s total, 7.597 GiB peak; 1448²/8 steps 36.91 s total, 8.199 GiB peak. Both acknowledge zero torch allocation after cleanup; owned workers exit. Local artifacts and source backups remain ignored. Task 7 is active: all DiT/connectors/Gemma tensor shapes match installed native components; 25-frame 384×256 latent generation completed at 6.295 GiB peak. Video decoder needs compiled neighborhood attention; no video capability is advertised yet. Main installation remains unchanged.
