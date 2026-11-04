# Media tools, preset collections and persisted canvas history

The user's full reconstruction scope remains unchanged. This iteration continues approved work, using reference evidence rather than invented service responses. Its verified scope and remaining gaps are recorded in ../media-tools-history-verification.md.

## Ownership and interfaces

- Preset investigation agent: owns tools/cache-other-presets.mjs, private captures, public new scene/prop/effect images and backend/app/material_presets_extra.json plus matching public/reference/material-presets-extra.json. Uses its own reference browser page; no paid writes, no credential export. Root integrates normalized {source,collections:[{id,name,kind,url,material_count,items:[{id,name,kind,description,url,metadata}]}]}. Do not reinterpret drawing styles as assets. Preserve unavailable assets explicitly.
- Media backend agent: owns backend/app/media_tools.py, tests/test_media_tools.py and docs/media-tools.md. Functions `inspect_media(app,session,owner_id,source_url)`, `validate_operation(app,session,owner_id,kind,parameters)`, `execute_operation(app,session,owner_id,parameters)`. Supported operation names crop_image/crop_video/trim_video/trim_audio/extract_frame. Task kind is output medium image/video/audio; parameters.operation identifies the explicit local FFmpeg transformation. Source_url must be an owned /media URL. Crops use x/y/width/height in pixels; trims use start/end seconds; frame uses at seconds. Output follows existing {_image_bytes|_video_bytes|_audio_bytes,extension,content_type,...}. Operation must validate source type/dimensions/duration; invalid422, no processor503. Root wires tasks cost0, real queue, idempotency, target CAS and inspect GET route. No input URL fetching or shell expressions, no generated missing media.
- Canvas history agent: owns backend/app/canvas_versions.py, tests/test_canvas_versions.py and web/src/CanvasVersions.tsx + canvas-versions.css. Defines Base model and `checkpoint(session,project_id,owner_id,data,revision,kind='auto',name='')`; snapshot row must retain immutable deep-copied graph. register_canvas_versions(app,owner,database,owned) registers GET/POST /api/projects/{id}/canvas/versions (list metadata envelope with total,limit,offset; POST manual{name}); GET /versions/{vid} full graph; POST /versions/{vid}/restore {revision} validates current revision, captures current graph as before_restore and monotonically increments revision. No history purge. Frontend props {projectId,prepare:()=>Promise<number|null>,onRestored:(graph)=>void,onClose:()=>void}; prepare flushes current edits and returns actual revision or null on failure. Root integrates editor hook and snapshots into successful canvas PUT/generation writes.
- Root: reference media dialog capture, new MediaTools.tsx panel and ShotEditor wiring, main task dispatcher/targets, canvas editor hooks, real preset integration, migrations/startup imports, tests/browser checks/review.

## Verification
- [x] Reference media control labels and preset request schemas captured; original media-processing execution/request details remain unverified and are recorded as limitations.
- [x] Owned media transform pixel/duration assertions, invalid input, unknown operation, source ownership, no debit, task idempotency and conflict behavior.
- [x] Canvas snapshot persistence/restore/backup, concurrent revision conflicts, cross-account/project rejection, no snapshots on failed writes.
- [x] Preset catalogue identities/counts/media hashes; missing gallery caching remains explicitly open.
- [x] Fresh frontend build/tests and PostgreSQL+MinIO+Redis+FFmpeg integration.
- [x] Browser persisted result and actual byte metadata checks, followed by scoped independent review and fixes for rotation, final-frame and cross-project restore issues.

Full proprietary model behavior, payment and collaboration remain open. Reference spend budget is cumulative290;37 spent and253 last observed, no new payment authority.
