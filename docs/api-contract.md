# Local API contract

Base /api. JSON direct objects; lists {items:[],total:0}. Errors {detail:string}. IDs are UUID strings. Timestamps ISO-8601.
Local development account is explicit; bind services only to loopback. Endpoint /api/session returns {user:{id,name,avatar},space:{id,name},credits:number,provider_status:{text:boolean,image:boolean,video:boolean,audio:boolean},mode:"local"}.

- GET /api/health; GET /api/catalog -> {styles:[],models:[],presets:[],announcements:[],examples:[]}
- GET/POST /api/projects; GET/PATCH/DELETE /api/projects/{id}. Project {id,name,kind:"series"|"episode"|"script"|"canvas",genre:"anime"|"live"|"narration"|"redraw",description,aspect_ratio,style,script,settings:{},created_at,updated_at}. List query kind,q. POST accepts name,kind plus optional fields.
- GET/POST /api/projects/{id}/episodes; PATCH/DELETE /api/episodes/{id}. Episode {id,project_id,name,position,script,settings:{}}.
- GET/POST /api/projects/{id}/shots; PATCH/DELETE /api/shots/{id}. Shot {id,project_id,episode_id?,name,position,prompt,dialogue,duration,image_url?,video_url?,audio_url?,settings:{}}.
- GET/POST /api/assets; PATCH/DELETE /api/assets/{id}. Asset {id,name,kind:"character"|"scene"|"prop"|"effect"|"voice",description,url,style,metadata:{},created_at}. Query kind,q.
- POST /api/uploads multipart file -> {url,filename,size,content_type}; GET /media/{path} bytes.
- GET /api/projects/{id}/canvas -> {nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},revision:0}; PUT same with expected revision (409 on conflict).
- GET/POST /api/tasks. POST {kind:"text"|"image"|"video"|"audio"|"export",project_id?,prompt,parameters:{},idempotency_key}. Task {id,kind,status:"queued"|"running"|"succeeded"|"failed",progress,result:{},error?,created_at}. Unconfigured providers return 503, no task success/charge. GET /api/tasks/{id}; DELETE /api/tasks/{id} for completed tasks only.
- GET /api/credits -> {balance,items:[]}. PATCH /api/profile {name}; GET /api/spaces -> list.
- POST /api/projects/{id}/duplicate -> Project.
- POST /api/projects/{id}/parse-script -> {episodes:[],shots:[]} deterministic explicit local parser, no AI claims.

UI should tolerate added response fields. No production impersonation, remote login, real payments or third-party tokens are provided by local mode.

## Subjects and storyboards
- GET/POST /api/projects/{id}/subjects -> list envelope / Asset. Creation atomically links Asset to project.settings.asset_ids.
- POST /api/projects/{id}/subjects/import {asset_ids:[]} verifies all ownership before linking any. DELETE /api/projects/{id}/subjects/{asset_id} detaches without deleting the reusable Asset.
- GET /api/assets/{id} -> Asset. Asset, Shot and Project PATCH accept optional expected_updated_at; stale timestamp returns409 without mutation. Asset responses include updated_at.
- Subject metadata supports role, age, appearance, performance_info (distinct from appearance description), prompt, aspect_ratio, image_model, voice:{description,text,model,url}, gallery:[{id,name,url}], versions:[{id,name,kind,slot,url,created_at}].
- Task parameters.asset_id and asset_updated_at target an owned linked subject. Image gallery_slot must be main or an existing slot; audio ignores image selection. Results apply only if revision unchanged; otherwise retained in task history.
- POST /api/projects/{id}/shots/batch {shots:ShotInput[]} creates1–100 shots atomically; bad episodes/items rollback the whole batch. PUT /api/projects/{id}/shots/order {ids:[]} requires all current project shots exactly once and returns ordered list envelope; partial/stale set409.
- GET /api/material-presets -> {source,collections:[]}. Read-only captured collections are distinct from drawing styles. Frontend imports cached main images through /api/uploads to create owned S3 copies before creating an Asset.
