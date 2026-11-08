# Video confirmation implementation plan

**Goal:** require a reviewable, explicit approval for every video generation, including drafts, finals and retries, while preserving the existing photo authorization behavior.
**Architecture:** explicit workflow media type and supported video stages, native video tool, server-owned immutable proposal, one-use confirmation. Reuse the current GPU alternation and gallery. Support standard MP4/WebM Comfy outputs and bounded compressed frames for model review.
**Tech:** Node 22, vanilla browser modules, no new dependencies.
**Spec:** the user's video diagnostic and the subsequent approved confirmation design in this conversation.

## Constraints
- No hardcoded model or user workflow names; mappings and stage capabilities are declared at import.
- Photos keep their current permission behavior. Global authorization never approves a video.
- Approval must precede all GPU work and bind the effective prompt, workflow digest, references, parameters and Comfy server.
- Preserve all local data and leave existing app/Comfy instances alone. Stop our own test instances.
- This change does not invent a universal video extension algorithm or claim same-seed resolution changes preserve a clip. Those need the actual workflow input contracts.

## Review focus
- Video requested through the image tool must be rejected, not bypass confirmation.
- Changed workflows, endpoints or resources invalidate a pending proposal.
- Cancel, revision, expiration and concurrent clicks must not submit a video or unload the LLM.
- Video output must not be included in LLM context; only bounded timestamped reduced frames may be.
- Existing imports, history and complete browser module loading must still work.

## Tasks
1. Add failing tests for video workflow schema, native definition, mandatory per-call approval and cancellation/reuse; implement workflow declarations and runtime gate. Test with real catalogs and fake GPU boundaries.
2. Add output parsing/MIME tests for MP4/WebM Comfy descriptors; implement original video handling and compressed review frames/history. Keep image paths compatible.
3. Add UI tests for video import, explicit proposal/stage, confirmation/revision/cancellation and unaffected image auto-approval; implement the dialog and original video rendering.
4. Run all tests, smoke a temporary app in the browser, review diff, update EN/ZH/KO docs/version, commit and push. Close only test instances.

## Execution ledger
- Plan approved by the user's “go”; execute inline in the requested existing checkout. Existing permission to push persists. No additional approval menu.

- Backend gate and workflow declarations: tests fail before implementation, then pass. Video tool cannot use image permission; every approval is one-use and pins the workflow/address/arguments.
- Media and history: MP4/WebM descriptors, signed streaming/range proxy, bounded timestamped image copies; original bytes remain in Comfy.
- Browser smoke uses an isolated temporary app, fake native engine/Comfy and a 2-second synthetic clip. Verified draft/final dialogs, revision without submission, execution, Details and history reload; no real model/workflow generation claimed.
- Review: preserve current app on port 8787 and Comfy on 7821. Add no dependency, model download, hardcoded workflow or model name. Advanced continuation/latent reuse remains explicitly outside this approved confirmation change.

- Final review fixes: short initial video ranges no longer require a full signature inside a partial response; WebM without a browser MIME keeps its inferred type; video tool results retain a compact effective recipe for model follow-up. All three issues had failing regression tests before fixes. A separate reviewer was attempted but unavailable due to its usage limit; final review continued inline.
