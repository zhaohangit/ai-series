# Local FastAPI backend

Python 3.12; PostgreSQL is the primary deployment database. SQLite is an isolated unit-test and single-process development fallback.

```sh
uv sync --python 3.12
uv run uvicorn app.main:app --host 127.0.0.1 --port 8001
uv run pytest -q
```

Set `DATABASE_URL` to a PostgreSQL DSN (`postgresql://` or `postgresql+psycopg://`). Set a private persistent `SESSION_SECRET` for the signed local session cookie. Without it, development stores a generated mode-0600 secret next to `MEDIA_ROOT`; no key is embedded in source. The default local account has 1000 demonstration credits, with an auditable local ledger; these are not paid balances. Cookie, project, media, asset, task and ledger ownership all refer to this local account.

`MEDIA_ROOT` defaults to `./data/media`. Optional private object storage uses `S3_ENDPOINT_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` and optional `S3_REGION`. Startup creates the configured bucket if missing. `/media/...` always checks upload ownership before streaming filesystem or S3 bytes. S3 media supports HTTP Range. Upload size defaults to 50 MiB and can be lowered with `MAX_UPLOAD_BYTES`.

The standalone development server must bind to loopback. Browser origins default to localhost/127.0.0.1 ports 5175 and 8001; customize `CORS_ORIGINS` as a comma-separated explicit list. Mutation requests with a different Origin receive 403. No wildcard credentialed CORS is enabled. This local session mode is not multi-user Internet authentication.

## Providers and workers

Text generation uses `TEXT_PROVIDER_BASE_URL`, `TEXT_PROVIDER_API_KEY`, `TEXT_PROVIDER_MODEL`. Image generation uses the corresponding `IMAGE_PROVIDER_...` variables. Base URL includes the provider API prefix, typically `/v1`. Only an explicit configured provider is called. Text uses `/chat/completions`, images use `/images/generations`. Model parameters are allowlisted. Base64 image responses are stored privately; HTTPS URL responses are explicitly marked external and aren't fetched server-side. Provider error bodies and credentials are never included in task errors. Video and audio adapters are unavailable; no dummy media is generated.

`TASK_EXECUTOR=background` is the default for one-process local development. Restarting that API fails unfinished background jobs and refunds reservations; it does not retry uncertain external calls. Use one API process in this mode. `TASK_EXECUTOR=celery` dispatches to Redis via `REDIS_URL` (default `redis://localhost:26379/0`) and `CELERY_QUEUE` (default `dramabuddy`). Run the worker with the same database, session/storage/provider variables:

```sh
uv run celery -A app.worker.celery_app worker --loglevel=info
```

Jobs have an atomic queued-to-running claim and per-owner idempotency. Reservation, settlement and refund are unique ledger actions. Completed-task deletion keeps an idempotency tombstone. Celery redelivery of an interrupted running job fails/refunds the local reservation without making a second provider call, because the first external outcome is unknown. Redis redelivery after complete worker loss is bounded by `CELERY_VISIBILITY_TIMEOUT` (default 3600 seconds). A new deliberate generation needs a new idempotency key.

`parameters.shot_id` and `parameters.node_id` validate owner/project membership, and allow only one active job on that target. Submission snapshots the shot timestamp or canvas revision; optional `shot_updated_at`/`canvas_revision` reject stale submissions. Successful media applies only when that snapshot is unchanged. `result.application.status` is `applied`, `conflict`, `target_missing` or `result_only`. A conflict keeps the generated candidate in task history without overwriting edits. Canvas application increments revision and returns `result.application.canvas_revision`; clients must reload it. Text targeting a shot stays in the result; text targeting a canvas node can update node text.

## Exports and parser

Export tasks accept `parameters.format`: `json` (default), `zip`, or `mp4`. JSON includes project, episodes, shots and canvas. ZIP also bundles referenced owned media and a URL-to-archive manifest. MP4 uses real uploaded shot images/video plus selected or original audio; no missing source media is synthesized. It normalizes clips and concatenates with FFmpeg. Missing FFmpeg returns 503; missing/foreign/remote source media returns 422. `FFMPEG_BIN` can point at a host executable; Docker installs FFmpeg. Optional `FFPROBE_BIN` is reserved for deployment tooling; the renderer can inspect source audio through FFmpeg itself. Export is limited to 200 shots, 10 minutes, and ZIP media to 250 MiB. FFmpeg inputs restrict protocols/demuxers to local media formats to reject URL playlists. Temporary render files are removed.

`parse-script` is explicitly deterministic: chapter headings start episodes, non-empty lines become shots. It never calls AI and does not save automatically. The caller can review and persist its returned episodes/shots. Catalogue labels and assets are bundled fixtures; `reference_only:true` and `available:false` on those model records distinguish them from configured providers.

## Verification

Tests use isolated SQLite files by default. For live integration, set `TEST_DATABASE_URL`; each test creates and drops a dedicated random PostgreSQL schema. Optional S3 tests require `TEST_S3_ENDPOINT_URL`, `TEST_S3_ACCESS_KEY`, `TEST_S3_SECRET_KEY`; their random bucket is removed. `TEST_REDIS_URL` enables a real Celery process with an isolated random queue and a local HTTP test provider. It never calls a paid external provider. Set `FFMPEG_BIN` to run actual image/video/audio export tests; otherwise these tests are explicitly skipped. No credentials should appear in command output.

Schema startup currently uses SQLAlchemy `create_all` for the initial schema. Future incompatible schema changes require migrations; `create_all` is not an upgrade migration system. Generation-provider end-to-end validation remains open until a real provider is authorized/configured.
