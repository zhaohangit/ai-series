"""Deterministic transformations of owned media; no provider or network access."""
import math
import re
import subprocess
import tempfile
import time
from contextlib import contextmanager
from fractions import Fraction
from pathlib import Path

from fastapi import HTTPException

from .exports import ffmpeg_binary, local_media


OPERATIONS = {
    "crop_image": ("image", "image"),
    "crop_video": ("video", "video"),
    "trim_video": ("video", "video"),
    "trim_audio": ("audio", "audio"),
    "extract_frame": ("video", "image"),
}
MAX_BYTES = 250 * 1024 * 1024
MAX_DURATION = 600
MAX_FRAME_SCAN = 120_000


def _invalid(message):
    raise HTTPException(422, message)


def _processor():
    executable = ffmpeg_binary()
    if not executable:
        raise HTTPException(503, "FFmpeg is unavailable; set FFMPEG_BIN to enable media tools")
    return executable


def _container(data, content_type):
    """A signature-selected demuxer prevents playlists being interpreted as input."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        position = 8
        while position + 8 <= len(data):
            length = int.from_bytes(data[position:position + 4], "big")
            if data[position + 4:position + 8] == b"acTL":
                _invalid("Animated PNG is unsupported; export a still PNG or video first")
            position += length + 12
        spec = ("png_pipe", "image", ("image/png",))
    elif data.startswith(b"\xff\xd8\xff"):
        spec = ("jpeg_pipe", "image", ("image/jpeg", "image/jpg"))
    elif data[:6] in (b"GIF87a", b"GIF89a"):
        _invalid("GIF media is unsupported by these tools; export a still PNG or video first")
    elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        if b"ANIM" in data or (data[12:16] == b"VP8X" and len(data) > 20 and data[20] & 2):
            _invalid("Animated WebP is unsupported; export a still PNG or video first")
        spec = ("webp_pipe", "image", ("image/webp",))
    elif data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        spec = ("wav", "audio", ("audio/wav", "audio/x-wav", "audio/wave"))
    elif len(data) >= 12 and data[4:8] == b"ftyp":
        spec = ("mov", "audio" if content_type in ("audio/mp4", "audio/x-m4a") else "video", ("video/mp4", "video/quicktime", "audio/mp4", "audio/x-m4a"))
    elif data.startswith(b"\x1aE\xdf\xa3"):
        spec = ("matroska", "audio" if content_type == "audio/webm" else "video", ("video/webm", "video/x-matroska", "audio/webm"))
    elif data.startswith(b"OggS"):
        spec = ("ogg", "audio", ("audio/ogg", "audio/opus"))
    elif data.startswith(b"fLaC"):
        spec = ("flac", "audio", ("audio/flac", "audio/x-flac"))
    elif data.startswith(b"ID3") or (len(data) > 1 and data[0] == 255 and data[1] & 0xE0 == 0xE0):
        spec = ("mp3", "audio", ("audio/mpeg", "audio/mp3"))
    else:
        _invalid("Unsupported or malformed media; playlists and remote sources are not accepted")
    if content_type not in spec[2]:
        _invalid("Stored media MIME type does not match the actual media format")
    return spec[0], spec[1]


def _run(command, *, timeout=30):
    try:
        result = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    except (FileNotFoundError, PermissionError):
        raise HTTPException(503, "FFmpeg is unavailable") from None
    except subprocess.TimeoutExpired:
        _invalid("Media processing exceeded the local time limit")
    except OSError:
        raise HTTPException(503, "Media processor could not be started") from None
    if result.returncode:
        # Never surface stderr: input metadata can contain private paths or content.
        _invalid("Media could not be decoded or processed")
    return result


def _input(demuxer, path):
    options = ["-protocol_whitelist", "file,pipe", "-format_whitelist", demuxer, "-f", demuxer]
    if demuxer == "mov":
        # MOV external data references must never resolve local files or URLs.
        options += ["-enable_drefs", "0", "-use_absolute_path", "0"]
    return [*options, "-i", str(path)]


@contextmanager
def _source(app, session, owner_id, source_url):
    record = local_media(session, owner_id, source_url)
    executable = _processor()
    if record.size > MAX_BYTES:
        _invalid("Media tools accept at most 250 MiB per source")
    try:
        contents = app.state.storage.read(record.path)
    except (OSError, KeyError):
        _invalid("Source media is unavailable")
    if not contents or len(contents) > MAX_BYTES:
        _invalid("Source media is empty or exceeds 250 MiB")
    demuxer, kind = _container(contents, record.content_type.lower().split(";", 1)[0].strip())
    with tempfile.TemporaryDirectory(prefix="dramabuddy-media-") as directory:
        path = Path(directory) / "source"
        path.write_bytes(contents)
        command = [executable, "-hide_banner", "-nostdin", "-nostats", "-xerror", *_input(demuxer, path), "-t", "0.01", "-f", "null", "-"]
        result = _run(command, timeout=20)
        # Read the input section only; output may have different dimensions/streams.
        description = result.stderr.decode("utf-8", "replace").split("Stream mapping:", 1)[0]
        rotation_match = re.search(r"(?:rotate\s*:\s*|rotation of\s+)(-?\d+(?:\.\d+)?)", description, re.IGNORECASE)
        rotation_degrees = float(rotation_match.group(1)) % 360 if rotation_match else 0.0
        quarter_turns = round(rotation_degrees / 90)
        if abs(rotation_degrees - quarter_turns * 90) > 0.01:
            _invalid("Only right-angle video display rotations are supported")
        rotation = int(quarter_turns * 90) % 360
        video_lines = [line for line in description.splitlines() if re.search(r"Stream #\d+:\d+.*Video:", line)]
        audio_lines = [line for line in description.splitlines() if re.search(r"Stream #\d+:\d+.*Audio:", line)]
        width = height = duration = frame_rate = None
        if video_lines:
            rate_match = re.search(r"\b(\d+(?:\.\d+)?)\s+fps\b", video_lines[0])
            if rate_match:
                frame_rate = float(rate_match.group(1))
            match = re.search(r"(?:^|\s)([1-9]\d{0,5})x([1-9]\d{0,5})(?:[\s,]|$)", video_lines[0])
            if not match:
                _invalid("Source media has no valid image dimensions")
            width, height = map(int, match.groups())
            if rotation in (90, 270):
                width, height = height, width
            if min(width, height) < 1 or max(width, height) > 16384 or width * height > 40_000_000:
                _invalid("Source dimensions exceed the local processing limit")
        if kind == "image" and (not video_lines or audio_lines):
            _invalid("Image source does not contain a decodable still image")
        if kind == "video" and not video_lines:
            _invalid("Video source does not contain a video stream")
        if kind == "audio" and (not audio_lines or video_lines):
            _invalid("Audio source must contain audio without video streams")
        if kind != "image":
            match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", description)
            if match:
                hours, minutes, seconds = map(float, match.groups())
                duration = hours * 3600 + minutes * 60 + seconds
            if duration is None or not 0 < duration <= MAX_DURATION:
                _invalid("Source media requires a known duration of at most 600 seconds")
        info = {"source_url": source_url, "kind": kind, "content_type": record.content_type, "format": demuxer,
                "width": width, "height": height, "duration": duration, "rotation": rotation,
                "frame_rate": frame_rate,
                "has_video": bool(video_lines), "has_audio": bool(audio_lines), "animated": False}
        yield executable, path, info


def inspect_media(app, session, owner_id, source_url):
    """Return verified metadata for an uploaded object belonging to this owner."""
    with _source(app, session, owner_id, source_url) as (_, _, info):
        return info


def _number(parameters, key, *, integer=False):
    value = parameters.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _invalid(f"{key} must be a finite {'integer' if integer else 'number'}")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite or (integer and value != int(value)):
        _invalid(f"{key} must be a finite {'integer' if integer else 'number'}")
    return int(value) if integer else float(value)


def _validate(kind, parameters, info):
    operation = parameters.get("operation")
    if operation not in OPERATIONS:
        _invalid("Unsupported media operation")
    source_kind, output_kind = OPERATIONS[operation]
    if kind != output_kind or info["kind"] != source_kind:
        _invalid("Source media and task kind must match the media operation")
    normalized = dict(parameters)
    if operation.startswith("crop_"):
        values = {key: _number(parameters, key, integer=True) for key in ("x", "y", "width", "height")}
        if min(values["x"], values["y"]) < 0 or min(values["width"], values["height"]) < 1:
            _invalid("Crop origin must be nonnegative and crop dimensions must be positive")
        if values["x"] + values["width"] > info["width"] or values["y"] + values["height"] > info["height"]:
            _invalid("Crop rectangle lies outside the source dimensions")
        if operation == "crop_video" and (values["width"] % 2 or values["height"] % 2):
            _invalid("Video crop width and height must be even for browser-compatible MP4 output")
        normalized.update(values)
        if operation == "crop_video" and ("start" in parameters or "end" in parameters):
            start, end = _number(parameters, "start"), _number(parameters, "end")
            if not 0 <= start < end <= info["duration"]:
                _invalid("Crop time range must satisfy 0 <= start < end <= source duration")
            normalized.update(start=start, end=end)
    elif operation.startswith("trim_"):
        if operation == "trim_video" and (info["width"] % 2 or info["height"] % 2):
            _invalid("Video trim requires even source width and height for browser-compatible MP4 output")
        start, end = _number(parameters, "start"), _number(parameters, "end")
        if not 0 <= start < end <= info["duration"]:
            _invalid("Trim range must satisfy 0 <= start < end <= source duration")
        normalized.update(start=start, end=end)
    else:
        at = _number(parameters, "at")
        if not 0 <= at < info["duration"]:
            _invalid("Frame time must satisfy 0 <= at < source duration")
        normalized["at"] = at
    return normalized


def validate_operation(app, session, owner_id, kind, parameters):
    """Validate before creating a task; return a normalized parameter dictionary."""
    if not isinstance(parameters, dict) or not isinstance(parameters.get("operation"), str) or parameters["operation"] not in OPERATIONS:
        _invalid("Unsupported media operation")
    with _source(app, session, owner_id, parameters.get("source_url")) as (_, _, info):
        return _validate(kind, parameters, info)


def _displayed_frame(executable, path, info, at):
    """Locate by decoded presentation timestamps, never by average frame rate."""
    # Scaling to one pixel makes framecrc output compact without retaining full
    # decoded images. The native filter timebase preserves VFR presentation times.
    command = [executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror",
               *_input(info["format"], path), "-map", "0:v:0", "-an", "-sn", "-dn",
               "-vf", "scale=1:1", "-c:v", "rawvideo", "-pix_fmt", "gray",
               "-fps_mode", "passthrough", "-enc_time_base", "filter",
               "-frames:v", str(MAX_FRAME_SCAN + 1), "-f", "framecrc", "pipe:1"]
    result = _run(command, timeout=60)
    if len(result.stdout) > 16 * 1024 * 1024:
        _invalid("Video frame timing exceeds the local inspection limit")
    timebase = None
    count = 0
    chosen = None
    first = None
    previous = None
    requested = Fraction(str(at))
    for line in result.stdout.decode("ascii", "strict").splitlines():
        if line.startswith("#tb 0:"):
            try:
                timebase = Fraction(line.partition(":")[2].strip())
            except (ValueError, ZeroDivisionError):
                _invalid("Video frame timing is invalid")
            if timebase <= 0:
                _invalid("Video frame timing is invalid")
        elif line and not line.startswith("#"):
            fields = [value.strip() for value in line.split(",")]
            if timebase is None or len(fields) != 6 or fields[0] != "0":
                _invalid("Video frame timing could not be inspected")
            try:
                timestamp = int(fields[2]) * timebase
            except ValueError:
                _invalid("Video frame timing is invalid")
            if previous is not None and timestamp < previous:
                _invalid("Nonmonotonic video presentation timestamps are unsupported")
            previous = timestamp
            first = first or (count, timestamp)
            if timestamp <= requested:
                chosen = (count, timestamp)
            count += 1
    if count > MAX_FRAME_SCAN:
        _invalid(f"Video frame timing exceeds the {MAX_FRAME_SCAN}-frame local limit")
    if first is None:
        _invalid("Video contains no decodable frames")
    index, timestamp = chosen if chosen is not None else first
    return index, float(timestamp)


def execute_operation(app, session, owner_id, parameters):
    """Recheck ownership and bounds at execution, then return actual transformed bytes."""
    if not isinstance(parameters, dict) or not isinstance(parameters.get("operation"), str) or parameters["operation"] not in OPERATIONS:
        _invalid("Unsupported media operation")
    operation = parameters["operation"]
    output_kind = OPERATIONS[operation][1]
    with _source(app, session, owner_id, parameters.get("source_url")) as (executable, path, info):
        values = _validate(output_kind, parameters, info)
        deadline = time.monotonic() + 120
        extension, content_type = {"image": ("png", "image/png"), "video": ("mp4", "video/mp4"), "audio": ("wav", "audio/wav")}[output_kind]
        output = path.parent / ("output." + extension)
        command = [executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-xerror", *_input(info["format"], path)]
        metadata = {"kind": output_kind, "operation": operation, "source_url": info["source_url"], "source": info,
                    "extension": extension, "content_type": content_type}
        if operation.startswith("crop_"):
            command += ["-map", "0:v:0", "-vf", f"crop=w={values['width']}:h={values['height']}:x={values['x']}:y={values['y']}:exact=1"]
            metadata.update(width=values["width"], height=values["height"])
            if operation == "crop_video" and "start" in values:
                command += ["-ss", str(values["start"]), "-t", str(values["end"] - values["start"])]
                metadata["duration"] = values["end"] - values["start"]
        elif operation.startswith("trim_"):
            command += ["-ss", str(values["start"]), "-t", str(values["end"] - values["start"])]
            if output_kind == "video":
                command += ["-map", "0:v:0"]
            metadata["duration"] = values["end"] - values["start"]
        else:
            frame_index, frame_at = _displayed_frame(executable, path, info, values["at"])
            command += ["-map", "0:v:0", "-vf", f"select=eq(n\\,{frame_index})", "-fps_mode", "passthrough"]
            metadata.update(width=info["width"], height=info["height"], at=frame_at,
                            requested_at=values["at"], frame_index=frame_index)
        if output_kind == "image":
            command += ["-frames:v", "1", "-c:v", "png", "-an"]
        elif output_kind == "video":
            width, height = metadata.get("width", info["width"]), metadata.get("height", info["height"])
            command += ["-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]
            metadata.update(width=width, height=height)
            metadata.setdefault("duration", info["duration"])
        else:
            command += ["-map", "0:a:0", "-vn", "-c:a", "pcm_s16le"]
        command += ["-map_metadata", "-1", "-map_chapters", "-1", "-fs", str(MAX_BYTES + 1), str(output)]
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _invalid("Media processing exceeded the local time limit")
        _run(command, timeout=remaining)
        if not output.is_file() or not output.stat().st_size:
            _invalid("Requested operation produced no media")
        if output.stat().st_size > MAX_BYTES:
            _invalid("Processed media exceeds the 250 MiB output limit")
        metadata["_" + output_kind + "_bytes"] = output.read_bytes()
        return metadata
