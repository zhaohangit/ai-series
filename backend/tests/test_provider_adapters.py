"""Exercise optional media adapters against an isolated local HTTP provider."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.providers import OpenAICompatibleProvider

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00test-audio"
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42"


@pytest.fixture
def media_provider(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        requests = []
        statuses = ["queued", "in_progress", "completed"]
        audio = MP3
        audio_type = "audio/mpeg"
        video = MP4
        video_type = "video/mp4"
        video_id = "job_123"
        redirect = False

        def send_body(self, body, content_type="application/json", code=200):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self.requests.append(("POST", self.path, payload))
            assert self.headers["Authorization"] == "Bearer local-fixture-key"
            if self.path == "/v1/audio/speech":
                self.send_body(self.audio, self.audio_type)
            elif self.path == "/v1/videos":
                self.send_body(json.dumps({"id": self.video_id, "status": self.statuses[0], "url": "http://127.0.0.1:1/never-fetch"}).encode())
            else:
                self.send_error(404)

        def do_GET(self):
            self.requests.append(("GET", self.path, None))
            if self.path == "/v1/videos/job_123/content":
                if self.redirect:
                    self.send_response(302)
                    self.send_header("Location", "http://127.0.0.1:1/never-fetch")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self.send_body(self.video, self.video_type)
            elif self.path == "/v1/videos/job_123":
                if len(self.statuses) > 1:
                    self.statuses.pop(0)
                self.send_body(json.dumps({"id": "job_123", "status": self.statuses[0]}).encode())
            else:
                self.send_error(404)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for kind in ("AUDIO", "VIDEO"):
        monkeypatch.setenv(kind + "_PROVIDER_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
        monkeypatch.setenv(kind + "_PROVIDER_API_KEY", "local-fixture-key")
        monkeypatch.setenv(kind + "_PROVIDER_MODEL", "fixture-model")
    monkeypatch.setenv("VIDEO_PROVIDER_POLL_INTERVAL_SECONDS", "0.01")
    try:
        yield OpenAICompatibleProvider(), Handler
    finally:
        server.shutdown()
        server.server_close()


def test_available_requires_complete_valid_configuration(monkeypatch):
    provider = OpenAICompatibleProvider()
    for kind in ("text", "image", "audio", "video"):
        for field in ("BASE_URL", "API_KEY", "MODEL"):
            monkeypatch.delenv(f"{kind.upper()}_PROVIDER_{field}", raising=False)
        assert not provider.available(kind)
    assert not provider.available("unknown")
    monkeypatch.setenv("AUDIO_PROVIDER_BASE_URL", "https://provider.invalid/v1")
    monkeypatch.setenv("AUDIO_PROVIDER_API_KEY", "local-fixture-key")
    monkeypatch.setenv("AUDIO_PROVIDER_MODEL", "configured-model")
    assert provider.available("audio")
    monkeypatch.setenv("AUDIO_PROVIDER_BASE_URL", "https://user:password@provider.invalid/v1")
    assert not provider.available("audio")


def test_speech_returns_validated_audio_bytes(media_provider):
    provider, handler = media_provider
    result = provider.generate("audio", "Narration", {"voice": "nova", "speed": 1.2})
    assert result["_audio_bytes"] == MP3
    assert result["content_type"] == "audio/mpeg"
    assert result["extension"] == "mp3"
    payload = handler.requests[0][2]
    assert payload == {"model": "fixture-model", "input": "Narration", "voice": "nova", "speed": 1.2, "response_format": "mp3"}


@pytest.mark.parametrize("content,content_type", [(b"", "audio/mpeg"), (b"<html>oops</html>", "audio/mpeg"), (MP3, "application/json")])
def test_speech_rejects_empty_malformed_or_mislabeled_media(media_provider, content, content_type):
    provider, handler = media_provider
    handler.audio, handler.audio_type = content, content_type
    with pytest.raises(RuntimeError):
        provider.generate("audio", "Narration", {})


def test_speech_download_is_bounded(media_provider, monkeypatch):
    provider, _ = media_provider
    monkeypatch.setenv("AUDIO_PROVIDER_MAX_BYTES", "8")
    with pytest.raises(RuntimeError, match="size"):
        provider.generate("audio", "Narration", {})


def test_video_polls_and_downloads_only_configured_endpoint(media_provider):
    provider, handler = media_provider
    result = provider.generate("video", "A sunrise", {"duration": 4, "size": "1280x720", "reference_url": "https://images.example/reference.png"})
    assert result["_video_bytes"] == MP4
    assert result["content_type"] == "video/mp4"
    assert result["extension"] == "mp4"
    assert handler.requests == [
        ("POST", "/v1/videos", {"model": "fixture-model", "prompt": "A sunrise", "duration": 4, "size": "1280x720", "reference_url": "https://images.example/reference.png"}),
        ("GET", "/v1/videos/job_123", None),
        ("GET", "/v1/videos/job_123", None),
        ("GET", "/v1/videos/job_123/content", None),
    ]


@pytest.mark.parametrize("status", ["failed", "cancelled", "expired", "unexpected"])
def test_video_terminal_or_unknown_state_fails_without_download(media_provider, status):
    provider, handler = media_provider
    handler.statuses = [status]
    with pytest.raises(RuntimeError):
        provider.generate("video", "A sunrise", {})
    assert len(handler.requests) == 1


def test_video_polling_has_bounded_timeout(media_provider, monkeypatch):
    provider, handler = media_provider
    handler.statuses = ["queued"]
    monkeypatch.setenv("VIDEO_PROVIDER_TIMEOUT_SECONDS", "0.05")
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="timed out"):
        provider.generate("video", "A sunrise", {})
    assert time.monotonic() - started < 1
    assert not any(path.endswith("/content") for _, path, _ in handler.requests)


@pytest.mark.parametrize("video_id", ["../secret", "https://evil.invalid/content", "x?token=foo", ""])
def test_video_rejects_untrusted_job_id(media_provider, video_id):
    provider, handler = media_provider
    handler.video_id = video_id
    handler.statuses = ["completed"]
    with pytest.raises(RuntimeError):
        provider.generate("video", "A sunrise", {})
    assert len(handler.requests) == 1


@pytest.mark.parametrize("reference", ["file:///etc/passwd", "http://images.example/test.png", "https://localhost/test", "https://127.0.0.1/test", "https://user:password@images.example/test"])
def test_video_rejects_unsafe_reference_before_submission(media_provider, reference):
    provider, handler = media_provider
    with pytest.raises(RuntimeError):
        provider.generate("video", "A sunrise", {"reference_url": reference})
    assert not handler.requests


@pytest.mark.parametrize("content,content_type", [(b"", "video/mp4"), (b"<html>oops</html>", "video/mp4"), (MP4, "text/html")])
def test_video_rejects_invalid_content(media_provider, content, content_type):
    provider, handler = media_provider
    handler.video, handler.video_type = content, content_type
    handler.statuses = ["completed"]
    with pytest.raises(RuntimeError):
        provider.generate("video", "A sunrise", {})


def test_video_download_is_bounded(media_provider, monkeypatch):
    provider, handler = media_provider
    handler.statuses = ["completed"]
    monkeypatch.setenv("VIDEO_PROVIDER_MAX_BYTES", "8")
    with pytest.raises(RuntimeError, match="size"):
        provider.generate("video", "A sunrise", {})


def test_video_does_not_follow_content_redirect(media_provider):
    provider, handler = media_provider
    handler.statuses = ["completed"]
    handler.redirect = True
    with pytest.raises(Exception):
        provider.generate("video", "A sunrise", {})
    assert handler.requests[-1][1] == "/v1/videos/job_123/content"


def test_wav_speech_returns_wav_content_and_extension(media_provider):
    provider, handler = media_provider
    handler.audio = b"RIFF\x04\x00\x00\x00WAVEdata"
    handler.audio_type = "audio/x-wav"
    result = provider.generate("audio", "Narration", {"response_format": "wav"})
    assert result["_audio_bytes"] == handler.audio
    assert result["content_type"] == "audio/wav"
    assert result["extension"] == "wav"
    assert handler.requests[0][2]["response_format"] == "wav"


@pytest.mark.parametrize("parameters", [{"response_format": "pcm"}, {"voice": ""}, {"speed": 0}, {"speed": True}])
def test_audio_rejects_invalid_parameters_before_request(media_provider, parameters):
    provider, handler = media_provider
    with pytest.raises(RuntimeError):
        provider.generate("audio", "Narration", parameters)
    assert not handler.requests


@pytest.mark.parametrize("parameters", [{"duration": 0}, {"duration": True}, {"size": "huge"}, {"size": "8192x8192"}])
def test_video_rejects_invalid_parameters_before_submission(media_provider, parameters):
    provider, handler = media_provider
    with pytest.raises(RuntimeError):
        provider.generate("video", "A sunrise", parameters)
    assert not handler.requests
