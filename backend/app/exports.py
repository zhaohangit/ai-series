"""Render existing owned media with FFmpeg; never fabricate generated source media."""
import io
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select

from .models import Shot, Upload


def ffmpeg_binary():
    return shutil.which(os.getenv("FFMPEG_BIN", "ffmpeg"))


def local_media(session, owner_id, url):
    if not isinstance(url, str) or not url.startswith("/media/"):
        raise HTTPException(422, "Export requires uploaded local media; remote URLs are not fetched")
    record = session.scalar(select(Upload).where(Upload.path == url.removeprefix("/media/"), Upload.owner_id == owner_id))
    if record is None:
        raise HTTPException(422, "Referenced media is missing or belongs to another account")
    return record


def validate_export(session, owner_id, project_id, parameters):
    format = parameters.get("format", "json")
    if format not in ("json", "zip", "mp4"):
        raise HTTPException(422, "Supported export formats: json, zip, mp4")
    if format != "mp4":
        return
    if not ffmpeg_binary():
        raise HTTPException(503, "FFmpeg is unavailable; set FFMPEG_BIN to enable MP4 export")
    shots = session.scalars(select(Shot).where(Shot.project_id == project_id, Shot.owner_id == owner_id)).all()
    if not shots:
        raise HTTPException(422, "MP4 export requires shots with uploaded images or video")
    total = 0
    for shot in shots:
        local_media(session, owner_id, shot.data.get("video_url") or shot.data.get("image_url"))
        if shot.data.get("audio_url"):
            local_media(session, owner_id, shot.data["audio_url"])
        total += float(shot.data.get("duration", 5))
    if total > 600 or len(shots) > 200:
        raise HTTPException(422, "Local MP4 export is limited to 200 shots and 10 minutes")


def all_media_urls(value):
    if isinstance(value, str) and value.startswith("/media/"):
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from all_media_urls(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from all_media_urls(nested)


def export_zip(app, session, owner_id, bundle):
    stream = io.BytesIO()
    records = [local_media(session, owner_id, url) for url in sorted(set(all_media_urls(bundle)))]
    if sum(row.size for row in records) > 250 * 1024 * 1024:
        raise RuntimeError("Archive exceeds local export size limit")
    manifest = []
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("project.json", json.dumps(bundle, ensure_ascii=False, indent=2))
        for record in records:
            target = "media/" + Path(record.path).name
            archive.writestr(target, app.state.storage.read(record.path))
            manifest.append({"url": "/media/" + record.path, "archive_path": target, "filename": record.filename})
        archive.writestr("media-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return stream.getvalue()


def export_mp4(app, session, owner_id, bundle):
    executable = ffmpeg_binary()
    if executable is None:
        raise RuntimeError("FFmpeg unavailable")
    shots = sorted(bundle["shots"], key=lambda shot: shot["position"])
    ratio = bundle["project"].get("aspect_ratio", "16:9")
    width, height = (720, 1280) if ratio == "9:16" else (960, 960) if ratio == "1:1" else (1280, 720)
    with tempfile.TemporaryDirectory(prefix="dramabuddy-export-") as directory:
        root = Path(directory)
        clips = []
        input_options = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,image2,png_pipe,jpeg_pipe,webp_pipe,gif,matroska,webm,wav,mp3,ogg,flac,aac"]

        def materialize(url, index, suffix):
            record = local_media(session, owner_id, url)
            path = root / f"source-{index}-{suffix}{Path(record.path).suffix}"
            path.write_bytes(app.state.storage.read(record.path))
            return path

        for index, shot in enumerate(shots):
            is_video = bool(shot.get("video_url"))
            source = materialize(shot.get("video_url") or shot["image_url"], index, "visual")
            command = [executable, "-hide_banner", "-loglevel", "error", "-y"]
            command += [*input_options, "-stream_loop", "-1", "-i", str(source)] if is_video else [*input_options, "-loop", "1", "-framerate", "24", "-i", str(source)]
            if shot.get("audio_url"):
                audio = materialize(shot["audio_url"], index, "audio")
                command += [*input_options, "-stream_loop", "-1", "-i", str(audio)]
                audio_map = "1:a:0"
            else:
                # FFprobe is optional. FFmpeg's own inspection identifies original video audio.
                probe = subprocess.run([executable, "-hide_banner", *input_options, "-i", str(source)], capture_output=True, timeout=15)
                if is_video and b"Audio:" in probe.stderr:
                    audio_map = "0:a:0"
                else:
                    command += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
                    audio_map = "1:a:0"
            destination = root / f"clip-{index}.mp4"
            command += ["-map", "0:v:0", "-map", audio_map, "-t", str(shot["duration"]), "-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(destination)]
            subprocess.run(command, check=True, capture_output=True, timeout=max(60, int(shot["duration"] * 5)))
            clips.append(destination)
        listing = root / "clips.txt"
        listing.write_text("\n".join("file '" + path.name + "'" for path in clips))
        output = root / "timeline.mp4"
        subprocess.run([executable, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", "-movflags", "+faststart", str(output)], check=True, capture_output=True, timeout=120)
        return output.read_bytes()
