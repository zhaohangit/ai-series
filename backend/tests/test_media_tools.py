"""Real FFmpeg fixtures exercise transformations, metadata and ownership boundaries."""
import os
from pathlib import Path
import shutil
import subprocess

from fastapi import HTTPException
import pytest
from sqlalchemy import select

from app.models import Upload
from test_api import client


@pytest.fixture
def ffmpeg():
    executable = shutil.which(os.getenv("FFMPEG_BIN", "ffmpeg"))
    if not executable:
        pytest.skip("FFmpeg is not installed")
    return executable


def render(ffmpeg, path, *arguments):
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *arguments, str(path)], check=True, capture_output=True)
    return path.read_bytes()


def upload(client, data, filename, content_type):
    response = client.post("/api/uploads", files={"file": (filename, data, content_type)})
    assert response.status_code == 201, response.text
    url = response.json()["url"]
    with client.app.state.session_factory() as session:
        owner_id = session.scalar(select(Upload.owner_id).where(Upload.path == url.removeprefix("/media/")))
    return owner_id, url


def image_source(client, ffmpeg, tmp_path):
    data = render(ffmpeg, tmp_path / "source.png", "-f", "lavfi", "-i", "color=c=red:s=64x48,drawbox=x=32:y=0:w=32:h=48:color=blue:t=fill", "-frames:v", "1")
    return upload(client, data, "source.png", "image/png")


def video_source(client, ffmpeg, tmp_path):
    data = render(ffmpeg, tmp_path / "source.mp4", "-f", "lavfi", "-i", "testsrc2=s=64x48:r=10:d=2", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac")
    return upload(client, data, "source.mp4", "video/mp4")


def call(client, owner_id, function, *args):
    from app import media_tools
    with client.app.state.session_factory() as session:
        return getattr(media_tools, function)(client.app, session, owner_id, *args)


def decoded(ffmpeg, path, *args):
    return subprocess.run([ffmpeg, "-v", "error", "-i", str(path), *args, "pipe:1"], check=True, capture_output=True).stdout


def test_image_crop_changes_pixels_and_dimensions(client, ffmpeg, tmp_path):
    owner_id, url = image_source(client, ffmpeg, tmp_path)
    info = call(client, owner_id, "inspect_media", url)
    assert (info["kind"], info["width"], info["height"], info["duration"]) == ("image", 64, 48, None)
    params = {"operation": "crop_image", "source_url": url, "x": 32, "y": 0, "width": 32, "height": 48}
    call(client, owner_id, "validate_operation", "image", params)
    result = call(client, owner_id, "execute_operation", params)
    assert result["_image_bytes"].startswith(b"\x89PNG\r\n\x1a\n")
    assert result["operation"] == "crop_image" and result["source_url"] == url
    output = tmp_path / "cropped.png"
    output.write_bytes(result["_image_bytes"])
    pixels = decoded(ffmpeg, output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    assert len(pixels) == 32 * 48 * 3
    assert pixels[2] > 240 and pixels[0] < 10  # Crop selects blue half, not red.


def test_video_crop_preserves_duration_and_audio(client, ffmpeg, tmp_path):
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    params = {"operation": "crop_video", "source_url": url, "x": 1, "y": 3, "width": 32, "height": 24}
    result = call(client, owner_id, "execute_operation", params)
    assert b"ftyp" in result["_video_bytes"][:40]
    output_owner, output_url = upload(client, result["_video_bytes"], "crop.mp4", "video/mp4")
    info = call(client, output_owner, "inspect_media", output_url)
    assert (info["width"], info["height"], info["has_audio"]) == (32, 24, True)
    assert info["duration"] == pytest.approx(2, abs=.1)


def test_video_trim_decodes_requested_frame_count_and_audio(client, ffmpeg, tmp_path):
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    result = call(client, owner_id, "execute_operation", {"operation": "trim_video", "source_url": url, "start": .5, "end": 1.5})
    output = tmp_path / "trim.mp4"
    output.write_bytes(result["_video_bytes"])
    frames = decoded(ffmpeg, output, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24")
    assert len(frames) == 10 * 64 * 48 * 3
    audio = decoded(ffmpeg, output, "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "48000")
    assert 95000 < len(audio) < 101000 and any(audio)
    assert result["duration"] == pytest.approx(1, abs=.1)


def test_audio_trim_has_exact_decoded_sample_duration(client, ffmpeg, tmp_path):
    data = render(ffmpeg, tmp_path / "source.wav", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2")
    owner_id, url = upload(client, data, "source.wav", "audio/wav")
    result = call(client, owner_id, "execute_operation", {"operation": "trim_audio", "source_url": url, "start": .25, "end": 1})
    assert result["_audio_bytes"][:4] == b"RIFF"
    output = tmp_path / "trim.wav"
    output.write_bytes(result["_audio_bytes"])
    samples = decoded(ffmpeg, output, "-f", "s16le", "-ac", "1", "-ar", "48000")
    assert len(samples) == 72000 and any(samples)
    assert result["duration"] == pytest.approx(.75, abs=.01)


def test_extract_frame_matches_selected_source_frame(client, ffmpeg, tmp_path):
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    result = call(client, owner_id, "execute_operation", {"operation": "extract_frame", "source_url": url, "at": .5})
    output = tmp_path / "frame.png"
    output.write_bytes(result["_image_bytes"])
    actual = decoded(ffmpeg, output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    expected = decoded(ffmpeg, tmp_path / "source.mp4", "-ss", "0.5", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    assert actual == expected and len(actual) == 64 * 48 * 3


@pytest.mark.parametrize("fields", [
    {"x": -1}, {"x": 33}, {"y": 1}, {"width": 0}, {"height": 49}, {"x": 1.5},
    {"x": True}, {"x": "0"}, {"x": "0;movie=http://example.org"},
    {"x": float("nan")}, {"height": float("inf")},
])
def test_crop_rejects_nonfinite_nonnumeric_and_out_of_bounds(client, ffmpeg, tmp_path, fields):
    owner_id, url = image_source(client, ffmpeg, tmp_path)
    params = {"operation": "crop_image", "source_url": url, "x": 0, "y": 0, "width": 32, "height": 48, **fields}
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "validate_operation", "image", params)
    assert error.value.status_code == 422


@pytest.mark.parametrize("fields", [{"start": -1}, {"end": 3}, {"start": 1, "end": 1}, {"end": float("nan")}, {"start": "0"}, {"start": True}])
def test_trim_rejects_invalid_time_ranges(client, ffmpeg, tmp_path, fields):
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "validate_operation", "video", {"operation": "trim_video", "source_url": url, "start": 0, "end": 1, **fields})
    assert error.value.status_code == 422


@pytest.mark.parametrize("kind,operation", [("video", "crop_image"), ("image", "crop_video"), ("image", "unknown"), ("audio", "trim_audio")])
def test_source_and_output_kinds_must_match_operation(client, ffmpeg, tmp_path, kind, operation):
    owner_id, url = image_source(client, ffmpeg, tmp_path)
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "validate_operation", kind, {"operation": operation, "source_url": url, "x": 0, "y": 0, "width": 32, "height": 48, "start": 0, "end": 1})
    assert error.value.status_code == 422


@pytest.mark.parametrize("source_url", ["https://example.org/media.png", "/media/../private", "file:///tmp/image.png"])
def test_remote_and_unowned_paths_are_rejected(client, source_url):
    with pytest.raises(HTTPException) as error:
        call(client, "other-account", "inspect_media", source_url)
    assert error.value.status_code == 422


def test_cross_account_media_is_denied(client, ffmpeg, tmp_path):
    owner_id, url = image_source(client, ffmpeg, tmp_path)
    with pytest.raises(HTTPException) as error:
        call(client, "other-account", "execute_operation", {"operation": "crop_image", "source_url": url, "x": 0, "y": 0, "width": 1, "height": 1})
    assert error.value.status_code == 422


@pytest.mark.parametrize("payload,mime", [(b"#EXTM3U\nhttp://localhost:9999/leak.mp4\n", "video/mp4"), (b"not a png", "image/png"), (b"ffconcat version 1.0\nfile /etc/passwd\n", "video/mp4")])
def test_malformed_media_and_playlists_are_rejected(client, ffmpeg, payload, mime):
    owner_id, url = upload(client, payload, "malformed.mp4", mime)
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "inspect_media", url)
    assert error.value.status_code == 422


def test_declared_mime_must_match_actual_media(client, ffmpeg, tmp_path):
    data = render(ffmpeg, tmp_path / "source.png", "-f", "lavfi", "-i", "color=s=16x16", "-frames:v", "1")
    owner_id, url = upload(client, data, "disguised.mp4", "video/mp4")
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "inspect_media", url)
    assert error.value.status_code == 422


def test_gif_animation_is_explicitly_rejected(client, ffmpeg, tmp_path):
    data = render(ffmpeg, tmp_path / "source.gif", "-f", "lavfi", "-i", "testsrc2=s=32x32:r=2:d=1")
    owner_id, url = upload(client, data, "source.gif", "image/gif")
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "validate_operation", "image", {"operation": "crop_image", "source_url": url, "x": 0, "y": 0, "width": 16, "height": 16})
    assert error.value.status_code == 422 and "GIF" in str(error.value.detail)


def test_missing_processor_returns_503(client, monkeypatch):
    owner_id, url = upload(client, b"\x89PNG\r\n\x1a\n", "source.png", "image/png")
    monkeypatch.setenv("FFMPEG_BIN", "/missing/ffmpeg")
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "inspect_media", url)
    assert error.value.status_code == 503


@pytest.mark.parametrize("operation", [None, [], {}, 42])
def test_malformed_operation_is_a_validation_error(client, operation):
    with pytest.raises(HTTPException) as error:
        call(client, "owner", "validate_operation", "image", {"operation": operation, "source_url": "/media/missing"})
    assert error.value.status_code == 422


@pytest.mark.parametrize("at", [-.1, 2, float("nan"), float("inf"), True, "0"])
def test_frame_time_must_be_finite_and_inside_video(client, ffmpeg, tmp_path, at):
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "validate_operation", "image", {"operation": "extract_frame", "source_url": url, "at": at})
    assert error.value.status_code == 422


def test_animated_png_is_rejected_instead_of_silently_flattened(client, ffmpeg, tmp_path):
    data = render(ffmpeg, tmp_path / "animated.png", "-f", "lavfi", "-i", "testsrc2=s=32x32:r=2:d=1", "-f", "apng", "-plays", "0")
    owner_id, url = upload(client, data, "animated.png", "image/png")
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "inspect_media", url)
    assert error.value.status_code == 422


@pytest.mark.parametrize("width,height", [(31, 24), (32, 25)])
def test_video_crop_requires_even_dimensions_for_browser_playback(client, ffmpeg, tmp_path, width, height):
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    parameters = {"operation": "crop_video", "source_url": url, "x": 0, "y": 0, "width": width, "height": height}
    for function, arguments in [("validate_operation", ("video", parameters)), ("execute_operation", (parameters,))]:
        with pytest.raises(HTTPException) as error:
            call(client, owner_id, function, *arguments)
        assert error.value.status_code == 422 and "even" in str(error.value.detail).lower()


def test_trim_odd_sized_video_is_explicitly_rejected_for_browser_playback(client, ffmpeg, tmp_path):
    data = render(ffmpeg, tmp_path / "odd.mp4", "-f", "lavfi", "-i", "testsrc=s=31x25:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv444p")
    owner_id, url = upload(client, data, "odd.mp4", "video/mp4")
    info = call(client, owner_id, "inspect_media", url)
    assert (info["width"], info["height"]) == (31, 25)
    parameters = {"operation": "trim_video", "source_url": url, "start": 0, "end": .5}
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "validate_operation", "video", parameters)
    assert error.value.status_code == 422 and "even" in str(error.value.detail).lower()


def test_video_crop_can_trim_time_and_picture_together(client, ffmpeg, tmp_path):
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    parameters = {"operation": "crop_video", "source_url": url, "x": 2, "y": 4, "width": 32, "height": 24, "start": .5, "end": 1.5}
    result = call(client, owner_id, "execute_operation", parameters)
    output = tmp_path / "cropped-trimmed.mp4"
    output.write_bytes(result["_video_bytes"])
    pixels = decoded(ffmpeg, output, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24")
    assert len(pixels) == 10 * 32 * 24 * 3
    samples = decoded(ffmpeg, output, "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "48000")
    assert 95000 < len(samples) < 101000 and any(samples)
    assert result["duration"] == pytest.approx(1, abs=.01)
    owner, output_url = upload(client, result["_video_bytes"], "cropped-trimmed.mp4", "video/mp4")
    info = call(client, owner, "inspect_media", output_url)
    assert (info["width"], info["height"]) == (32, 24)
    assert info["duration"] == pytest.approx(1, abs=.1)


@pytest.mark.parametrize("time_range", [{"start": 0}, {"end": 1}, {"start": -.1, "end": 1}, {"start": 0, "end": 3}, {"start": 1, "end": 1}, {"start": float("nan"), "end": 1}, {"start": 0, "end": float("inf")}, {"start": True, "end": 1}, {"start": "0", "end": 1}])
def test_video_crop_optional_time_range_is_complete_finite_and_in_bounds(client, ffmpeg, tmp_path, time_range):
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    parameters = {"operation": "crop_video", "source_url": url, "x": 0, "y": 0, "width": 32, "height": 24, **time_range}
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "validate_operation", "video", parameters)
    assert error.value.status_code == 422


def rotated_video_source(client, ffmpeg, tmp_path):
    base = render(ffmpeg, tmp_path / "rotation-base.mp4", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=10:d=2,drawbox=x=32:y=0:w=32:h=48:color=blue:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p")
    base_path = tmp_path / "rotation-base.mp4"
    output = tmp_path / "rotated.mp4"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", str(base_path), "-c", "copy", str(output)], check=True, capture_output=True)
    return upload(client, output.read_bytes(), "rotated.mp4", "video/mp4")


def test_rotated_video_inspection_and_transform_use_display_space(client, ffmpeg, tmp_path):
    owner_id, url = rotated_video_source(client, ffmpeg, tmp_path)
    info = call(client, owner_id, "inspect_media", url)
    assert (info["width"], info["height"]) == (48, 64)
    assert info["rotation"] == 90
    crop = call(client, owner_id, "execute_operation", {"operation": "crop_video", "source_url": url, "x": 0, "y": 0, "width": 24, "height": 32})
    cropped_url = upload(client, crop["_video_bytes"], "rotated-crop.mp4", "video/mp4")[1]
    cropped = call(client, owner_id, "inspect_media", cropped_url)
    assert (cropped["width"], cropped["height"]) == (24, 32)
    assert crop["width"] == 24 and crop["height"] == 32
    frame = call(client, owner_id, "execute_operation", {"operation": "extract_frame", "source_url": url, "at": .5})
    frame_url = upload(client, frame["_image_bytes"], "rotated-frame.png", "image/png")[1]
    extracted = call(client, owner_id, "inspect_media", frame_url)
    assert (extracted["width"], extracted["height"]) == (48, 64)
    rotated_pixels = decoded(ffmpeg, tmp_path / "rotated.mp4", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    frame_path = tmp_path / "rotated-frame.png"
    frame_path.write_bytes(frame["_image_bytes"])
    extracted_pixels = decoded(ffmpeg, frame_path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    assert len(rotated_pixels) == len(extracted_pixels) == 48 * 64 * 3


@pytest.mark.parametrize("at", [1.9, 1.95, 1.999])
def test_extract_frame_at_end_selects_nearest_final_displayed_frame(client, ffmpeg, tmp_path, at):
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    result = call(client, owner_id, "execute_operation", {"operation": "extract_frame", "source_url": url, "at": at})
    actual_path = tmp_path / f"tail-{at}.png"
    actual_path.write_bytes(result["_image_bytes"])
    actual = decoded(ffmpeg, actual_path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    expected = decoded(ffmpeg, tmp_path / "source.mp4", "-ss", "1.9", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    assert actual == expected and len(actual) == 64 * 48 * 3


@pytest.mark.parametrize("at,frame_index", [(0, 0), (.05, 0), (.1, 1), (.5, 1), (1.199, 1), (1.2, 2), (1.8, 2), (1.9, 3)])
def test_extract_vfr_frame_is_the_frame_displayed_at_requested_time(client, ffmpeg, tmp_path, at, frame_index):
    # Frames display at 0, .1, 1.2 and 1.9 seconds; average FPS cannot locate
    # a held frame. Using output -ss instead would jump to the following frame.
    source = tmp_path / "variable-rate.mp4"
    data = render(ffmpeg, source, "-f", "lavfi", "-i", "testsrc=s=64x48:r=10:d=2",
                  "-vf", "select='eq(n,0)+eq(n,1)+eq(n,12)+eq(n,19)'", "-fps_mode", "vfr",
                  "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p")
    owner_id, url = upload(client, data, source.name, "video/mp4")
    result = call(client, owner_id, "execute_operation", {"operation": "extract_frame", "source_url": url, "at": at})
    output = tmp_path / "variable-frame.png"
    output.write_bytes(result["_image_bytes"])
    actual = decoded(ffmpeg, output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    expected = decoded(ffmpeg, source, "-vf", f"select=eq(n\\,{frame_index})", "-fps_mode", "passthrough", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    assert len(actual) == 64 * 48 * 3 and actual == expected
    assert result["at"] == pytest.approx([0, .1, 1.2, 1.9][frame_index])
    assert result["requested_at"] == at and result["frame_index"] == frame_index


def test_extract_vfr_tail_returns_the_actual_last_frame(client, ffmpeg, tmp_path):
    source = tmp_path / "variable-tail.mp4"
    data = render(ffmpeg, source, "-f", "lavfi", "-i", "testsrc=s=64x48:r=10:d=2",
                  "-vf", "select='eq(n,0)+eq(n,17)+eq(n,18)+eq(n,19)'", "-fps_mode", "vfr",
                  "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p")
    owner_id, url = upload(client, data, source.name, "video/mp4")
    info = call(client, owner_id, "inspect_media", url)
    at = info["duration"] - .001
    result = call(client, owner_id, "execute_operation", {"operation": "extract_frame", "source_url": url, "at": at})
    output = tmp_path / "variable-tail-frame.png"
    output.write_bytes(result["_image_bytes"])
    actual = decoded(ffmpeg, output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    expected = decoded(ffmpeg, source, "-vf", "select=eq(n\\,3)", "-fps_mode", "passthrough", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    assert len(actual) == 64 * 48 * 3 and actual == expected
    assert result["at"] == 1.9 and result["frame_index"] == 3


def test_frame_timestamp_scan_has_a_finite_decoded_frame_budget(client, ffmpeg, tmp_path, monkeypatch):
    from app import media_tools
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    monkeypatch.setattr(media_tools, "MAX_FRAME_SCAN", 3)
    with pytest.raises(HTTPException) as error:
        call(client, owner_id, "execute_operation", {"operation": "extract_frame", "source_url": url, "at": .5})
    assert error.value.status_code == 422 and "frame" in error.value.detail


def test_constant_rate_fractional_seek_keeps_current_frame_not_next(client, ffmpeg, tmp_path):
    owner_id, url = video_source(client, ffmpeg, tmp_path)
    result = call(client, owner_id, "execute_operation", {"operation": "extract_frame", "source_url": url, "at": .55})
    output = tmp_path / "fractional-seek.png"
    output.write_bytes(result["_image_bytes"])
    actual = decoded(ffmpeg, output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    expected = decoded(ffmpeg, tmp_path / "source.mp4", "-vf", "select=eq(n\\,5)", "-fps_mode", "passthrough", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    assert len(actual) == 64 * 48 * 3 and actual == expected
    assert result["at"] == .5 and result["requested_at"] == .55
