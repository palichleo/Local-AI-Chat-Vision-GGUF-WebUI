# Local ComfyUI tools implementation plan

> For agentic workers: execute the specified independent modules with TDD, integrate and review the complete change before publishing.

Goal: native model tools drive approved local workflows, with GPU alternation and an original-output gallery.

Architecture: Node backend owns workflow catalog, immutable tool requests, job state and GPU locking. ComfyClient speaks only loopback HTTP. The browser compresses output images before supplying vision feedback; originals are proxied unmodified from Comfy. History persists only compressed images and metadata.

Tech stack: Node22 standard libraries, browser canvas, existing SSE reader and llama-server.

Spec: docs/superpowers/specs/2026-11-08-comfy-tools.md.

## Tasks and interfaces

- [x] Probe actual model native tools: forced, automatic image request, ordinary text. All3 passed. Probe engine stopped.
- [x] Comfy HTTP client (`lib/comfy-client.mjs`, `tests/comfy-client.mjs`): `normalizeComfyUrl(value)` and `ComfyClient(baseUrl,{fetchImpl,pollMs})`; `status`, `workflows`, `workflow`, `objectInfo`, `upload`, `run`, `original`, `free` use `{signal}`. `run(graph,{signal,outputNodes,onProgress})` returns `{promptId,outputs:[{filename,subfolder,type:'output'}]}`. `original(source)` returns `{bytes,mime,filename}`. `free` waits idle/released memory; cancellation targets only its own prompt.
- [x] Workflow catalog (`lib/comfy-workflows.mjs`, tests): `WorkflowCatalog(directory).list/read/save/remove/prepare/definition`. Save `{id?,name,description,graph,bindings,outputNodes,requiresImage}`; API graphs only, actionable error on UI JSON. Bindings keys `prompt`, `negative_prompt`, `seed`, `width`, `height`, `image`, values `{node,input}`. `prepare(id,args,{referenceImage})` returns cloned `{graph,workflow,outputNodes}`. `definition()` advertises `comfy_generate_image` with workflow_id, prompt, optional negative_prompt/seed/width/height/reference_image. Prompt required. Never modify source graph or arbitrary nodes.
- [x] Gallery store (`lib/comfy-gallery.mjs`, tests): `ComfyGallery({historyDir}).put(record,{persist})/get(conversationId,runId)/list(conversationId)/clearMemory()`. Record `{id,conversationId,workflowId,workflowName,prompt,parameters,comfyUrl,createdAt,outputs:[{source:{filename,subfolder,type:'output'},analysisDataUrl?}]}`. Optional `analysis` text/status retained. Persist under history/<conversationId>/generated/<runId>/manifest.json plus compressed images only. No original file writes/deletes. Strict paths/IDs/image bytes. Nonpersistent runs are memory-only.
- [x] Integrate backend tool schema and native SSE requests; immutable nonce/digest, ask/once/always approval, settings/workflow endpoints and serialized job endpoints. Block manual/autostart/chat/history mutation while Comfy owns GPU. Restore engine after job cleanup; cancel scoped to job. Add mock integration tests.
- [x] Integrate client native transcript, approval dialog, job progress/cancel, analysis-image upload, bounded review loop, right gallery with original blob viewing/download and history restore. Preserve ordinary chat. Shared image preparation module:64 references, four-MP budget, PNG/JPEG smallest. Extend message validation/history for native tool messages and internal analysis images; do not render them as ordinary user posts.
- [x] Export a real user workflow through ComfyUI's official API export; import a copy and configure mapped parameters in ignored data. Validate and test benign generation plus native review. Never change the original workflow.
- [x] Full test suite, browser QA desktop/narrow layout, user-specific settings ignored, three README languages updated, independent final review, cleanup all launched instances, commit/push authorized repository.

## Review focus

- Unknown or changed workflow digest must not execute on stale approval.
- Model parser errors, malformed arguments, multiple calls and plain chat must not cause generation.
- Failure/cancellation at any GPU handoff must release owned resources and report recovery failures.
- History clearing must delete compressed files/links only; original bytes stay in Comfy output.
- Restored histories and closed pages must not silently rerun approved jobs.

## Decisions

Reuse F project checkout as instructed; scratch stays outside the source tree. API-format import is required for complex Comfy subgraphs rather than an unreliable handwritten converter. Existing real Comfy is on7821; generic default remains8188. Permissions default ask, limit3 per turn; these are configurable defaults, not prior user-selected values.

Validation: actual native Q6_K tools, Krea2 generation, unload/restart, vision feedback and corrective native call passed.16/64 duplicate250px references passed at32Kcontext; diverse-reference accuracy not assessed. Browser UI verification unavailable because local browser use was disabled in Work settings. Private local preset installed; no model/workflow originals changed.
