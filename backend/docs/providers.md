# Optional generation providers

The local backend does not include provider credentials.
A provider is available only after the operator sets its
base URL, API key, and model. Missing or malformed configuration leaves that kind
unavailable; task submission returns HTTP 503 before reserving local credits.
`available()` describes configuration readiness, not a remote health check.

Set configuration in the environment of the process that executes tasks. Celery
workers need the same provider environment as the API. Restart processes after
changing it. Credentials remain server-side; never put them in frontend settings.
The configured base includes any API prefix, such as `https://your-provider/v1`.
Base URLs must use HTTP or HTTPS and cannot contain user information, a query, or
a fragment. HTTP is useful for isolated local fixtures; use HTTPS for remote
providers. Requests do not follow redirects or inherit proxy environment settings.

| Kind | Required environment variables | Request |
| --- | --- | --- |
| Text | `TEXT_PROVIDER_BASE_URL`, `TEXT_PROVIDER_API_KEY`, `TEXT_PROVIDER_MODEL` | `POST /chat/completions` |
| Image | `IMAGE_PROVIDER_BASE_URL`, `IMAGE_PROVIDER_API_KEY`, `IMAGE_PROVIDER_MODEL` | `POST /images/generations` |
| Audio | `AUDIO_PROVIDER_BASE_URL`, `AUDIO_PROVIDER_API_KEY`, `AUDIO_PROVIDER_MODEL` | `POST /audio/speech` |
| Video | `VIDEO_PROVIDER_BASE_URL`, `VIDEO_PROVIDER_API_KEY`, `VIDEO_PROVIDER_MODEL` | Create, poll, then download as described below |

All requests send `Authorization: Bearer <configured key>`. Setting configuration
may enable paid calls when a user submits a generation task. Adapter tests use an
isolated local HTTP server and do not exercise any real model or paid service.

## Text and images

Text sends a single user message and accepts `temperature` and `max_tokens` task
parameters. It requires a nonempty string at `choices[0].message.content`.

Images request one image using `response_format: b64_json`, with optional `size`,
`quality`, and `style`. Base64 results return private `_image_bytes` for the task
worker to store. HTTPS URL responses are returned as external URLs; the backend
does not download arbitrary response URLs.

## Speech audio

Audio uses this JSON request contract:

```json
{
  "model": "configured-model",
  "input": "The task prompt becomes the spoken text.",
  "voice": "alloy",
  "response_format": "mp3"
}
```

Supported task parameters are `voice` (a nonempty string up to 128 characters),
`response_format` (`mp3` or `wav`), and optional numeric `speed` from 0.25 to 4.
The provider must return binary media directly. MP3 responses must declare
`audio/mpeg` or `audio/mp3` and begin with an ID3 or MPEG frame header. WAV responses
must declare a WAV audio content type and include RIFF/WAVE headers. Header checks
reject obvious wrong payloads; they do not fully decode or verify playback.

The response is streamed into a bounded buffer. `AUDIO_PROVIDER_MAX_BYTES` defaults
to 32 MiB and can be set from 1 byte to 64 MiB. Audio requests have a 180-second
deadline. Empty, malformed, mislabeled, oversized, redirect, and HTTP error
responses fail the task instead of publishing media.

The adapter returns `_audio_bytes`, `content_type`, and `extension` (`mp3` or `wav`)
plus provider/model metadata. These are private worker fields: the worker must
store the bytes and replace them with an application media URL before persisting
or serializing the task result.

## Asynchronous video

The video adapter implements the following JSON HTTP contract. It is configurable
for a compatible gateway; it is not a universal vendor SDK. A vendor using
multipart uploads, a different duration field, or different response statuses
needs a gateway that translates this contract.

1. `POST <base>/videos` submits JSON containing `model`, `prompt`, `duration`
   (integer seconds, default 4, range 1–120), and `size` (default `1280x720`, each
   dimension 64–4096). Optional `reference_url` is passed through only after
   validation. The response must be an object with an `id` and `status`.
2. Pending states `queued`, `pending`, `in_progress`, and `processing` cause
   polling of `GET <base>/videos/<id>`. The response must contain `status`.
3. `completed` allows `GET <base>/videos/<id>/content`. `failed`, `cancelled`,
   `canceled`, `expired`, and unknown statuses fail explicitly.
4. Content must declare `video/mp4` and include the MP4 `ftyp` header. The adapter
   returns `_video_bytes`, `content_type: video/mp4`, and `extension: mp4`, plus
   provider/model metadata. The worker must store these bytes before persisting
   the result, using the same private-field rule as audio.

IDs are limited to 1–200 ASCII letters, digits, hyphens, and underscores. All
polling and content requests stay under the configured base. Response fields
containing URLs are ignored, and redirects are rejected. Optional reference URLs
must use HTTPS without user information or a fragment; localhost, local host
suffixes, and nonpublic literal IP addresses are rejected. The application does
not fetch or DNS-resolve references; the gateway is responsible for its own fetch
policy and DNS/network protections.

| Optional setting | Default | Allowed range |
| --- | --- | --- |
| `VIDEO_PROVIDER_TIMEOUT_SECONDS` | 600 | 0.01–3600 seconds |
| `VIDEO_PROVIDER_POLL_INTERVAL_SECONDS` | 2 | 0.01–30 seconds |
| `VIDEO_PROVIDER_MAX_BYTES` | 128 MiB | 1 byte–256 MiB |

The video deadline covers creation, polling, and content download. Polling is
synchronous inside a worker; it does not block the FastAPI request handler when
using a task executor. A timeout stops local polling, but it does not cancel a job
already accepted by a remote provider or reverse a remote provider charge. The
application must not retry an uncertain paid request automatically.

## Local verification

From the backend directory:

```sh
.venv/bin/pytest tests/test_provider_adapters.py -q
```

This suite checks the adapter HTTP boundary using controlled fixture bytes,
request payloads, state transitions, limits, redirects, and failures. Passing it
establishes local contract behavior. Real provider compatibility, generated media
quality, and paid generation remain unverified until an operator intentionally
configures and exercises a chosen service.
