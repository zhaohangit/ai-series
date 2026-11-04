# Owned media tools

`app.media_tools` applies deterministic FFmpeg transformations to existing uploads.
It performs no AI generation, network source fetching, or provider calls. Queueing,
zero-cost task accounting, storage of returned bytes and target updates belong to
the API task dispatcher.

The module exposes three functions:

- `inspect_media(app, session, owner_id, source_url)` verifies ownership, the stored
  MIME type, container signature and decodability and returns media metadata.
- `validate_operation(app, session, owner_id, kind, parameters)` checks the requested
  output kind and bounds before task creation and returns normalized parameters.
- `execute_operation(app, session, owner_id, parameters)` rechecks ownership and
  validation at worker execution and returns the transformed media bytes.

A source must be an exact owned `/media/` upload record. The implementation resolves
it through `exports.local_media` and reads its bytes through `app.state.storage`,
which supports both local private storage and configured S3-compatible storage.
Remote, `file:` and unowned URLs are rejected. The upload filename does not decide
the decoder: a recognized byte signature and matching stored MIME are required.

## Operations

| operation | task kind | source kind | parameters | output |
| --- | --- | --- | --- | --- |
| `crop_image` | image | image | `x`, `y`, `width`, `height` in integer pixels | PNG |
| `crop_video` | video | video | `x`, `y`, `width`, `height` in integer pixels; optional `start` and `end` in seconds | H.264 MP4, original audio re-encoded as AAC if present |
| `trim_video` | video | video | `start`, `end` in seconds | H.264/AAC MP4 |
| `trim_audio` | audio | audio | `start`, `end` in seconds | 16-bit PCM WAV |
| `extract_frame` | image | video | `at` in seconds | PNG |

Every parameter dictionary contains `operation` and `source_url`. Numeric fields
must be actual finite JSON numbers; booleans and numeric strings are rejected.
Crop origins are nonnegative; dimensions are positive; the complete crop must fit
inside the source. Video crop can also trim time: omit both `start` and `end` to
keep the complete source duration, or supply both with a valid trim range. A
single time bound is rejected. Trim ranges satisfy `0 <= start < end <= duration`. Frame times
satisfy `0 <= at < duration`. Frame extraction decodes the presentation timestamps
and selects the last frame whose timestamp is at or before the requested time;
it does not divide by average frame rate or seek forward to the next frame.
If the stream begins after the requested time, it returns the first decoded frame.
The final decoded frame remains selected for the rest of the container duration.
For example, a 2-second 10 fps source accepts `1.95` and `1.999` and returns its
1.9-second frame. A variable-rate video with timestamps 0,0.1,1.2,1.9 returns its
0.1-second frame at0.5seconds. Video trims decode and re-encode
so they are not restricted to source keyframes. Video timing follows source frame
boundaries, and AAC sample padding can differ slightly from the requested range.

Video crop width and height must be even. Video trimming requires an even source
width and height. An odd dimension returns an explicit 422 validation error;
inputs are never silently resized or padded. All MP4 output uses H.264 `yuv420p`
for browser playback. Image crops and frame extraction accept odd dimensions.

## Metadata and results

Inspection returns:

```json
{
  "source_url": "/media/owner/upload.mp4",
  "kind": "video",
  "content_type": "video/mp4",
  "format": "mov",
  "width": 640,
  "height": 360,
  "duration": 12.5,
  "rotation": 0,
  "frame_rate": 24.0,
  "has_video": true,
  "has_audio": true,
  "animated": false
}
```

A still image has `duration: null`; audio has `width: null` and `height: null`.
`has_video` is true for a still image because FFmpeg represents the picture as a
video stream. Use `kind` to distinguish images from videos. Duration comes from
FFmpeg container inspection, with its displayed precision (normally hundredths
of a second). `rotation` is the normalized display-matrix angle (0, 90, 180 or
270). Video dimensions are reported in display coordinates, so 90/270 degree
sources expose swapped width and height. FFmpeg automatic rotation remains
enabled for every video transformation, including crop bounds, trim and frame
extraction. `frame_rate` is the detected video frame rate, or `null` when FFmpeg
does not report it. It is descriptive and is not used for frame selection.
FFprobe is not required: a bounded FFmpeg pass emits compact1×1frame CRC records
in the native filter timebase; a second pass selects the recorded decoded frame
index. Timestamp comparison uses rational arithmetic.

Execution returns `kind`, `operation`, `source_url`, the original `source`
inspection, `extension`, `content_type`, applicable dimensions/duration/frame time,
and one private bytes key: `_image_bytes`, `_video_bytes` or `_audio_bytes`.
Frame extraction also returns `requested_at` (the user's seconds value), `at`
(the selected decoded presentation time), and `frame_index` (zero-based decoded
index). These fields can differ for a held frame, including the final interval.
The dispatcher must persist that bytes value through the existing owned upload
storage helper and remove the private bytes key before JSON serialization.

## Supported sources and explicit limits

Supported inputs are still PNG, JPEG and WebP; MP4/QuickTime and WebM/Matroska
video; WAV, MP3, Ogg/Opus, FLAC, M4A/MP4 and WebM audio. These are signature and
stream checks, not filename extension checks. Audio input must contain audio
without an additional video or attached picture stream. Unsupported containers,
unknown durations and malformed bytes fail with HTTP 422.

All GIF input is explicitly rejected, including single-frame GIF. Animated PNG
and animated WebP are rejected. The processor never claims to preserve animation
when it only processed a still frame.

The local limits are 250 MiB for source and result, 600 seconds for audio/video,
16384 pixels per dimension and 40 million pixels per frame. Inspection has a
20-second timeout and execution a120-second shared budget. Frame extraction's
timestamp pass has a60-second sublimit and accepts at most120000decoded frames;
larger streams fail explicitly instead of returning an estimated frame. Nonmonotonic
decoded timestamps are rejected. Timestamp discovery uses the same forced local
demuxer/protocol restrictions as output generation. Inputs are placed in a
private temporary directory and removed on success or failure. A missing FFmpeg
returns 503; invalid input and processor failure return 422. Processor stderr is
not returned to users because metadata can contain private content.

FFmpeg is selected through the existing `FFMPEG_BIN` setting (default `ffmpeg`).
Commands use argument arrays, fixed codecs and numeric-only crop expressions.
The source demuxer is forced from the signature, file/pipe are the only allowed
input protocols, and MOV external data references and absolute paths are disabled.
Playlists, arbitrary filter expressions and user-supplied FFmpeg switches are not
accepted. Source metadata and chapters are removed from outputs.

## Verification

Run `FFMPEG_BIN=/path/to/ffmpeg .venv/bin/pytest tests/test_media_tools.py -q`
from `backend`. Set `TEST_DATABASE_URL` to exercise isolated PostgreSQL schemas;
otherwise the shared test fixture uses isolated SQLite files. The fixtures use
FFmpeg lavfi colors, test patterns and sine waves, never an AI provider.

The tests decode actual results to check selected crop pixels, exact crop sizes,
video frame count, preserved audio, audio sample duration, and selected-frame
pixels. They also exercise cross-account denial, MIME/signature mismatch,
malformed playlists, animation rejection, missing processor, unknown operations,
malformed operation values and finite numeric/range validation.
Real variable-frame-rate fixtures cover held-frame intervals, exact boundaries,
and densely spaced final frames that defeat average-FPS tail clamping. Constant-
rate fractional seeks and the decoded-frame budget are covered as regressions.

Container duration still comes from FFmpeg's displayed header precision, normally
hundredths of a second. A malformed container whose duration disagrees with its
actual timeline may reject otherwise decodable timestamps. The tests do not
establish every codec/edit-list/discontinuity combination. Frame discovery decodes
the complete stream and may hit its explicit timeout on long or expensive input.
