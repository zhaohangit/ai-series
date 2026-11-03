"""Explicit, opt-in provider boundary. No production reference API calls."""
import base64
import ipaddress
import json
import math
import os
import re
import time
from urllib.parse import urlsplit

import httpx


class OpenAICompatibleProvider:
    """Synchronous worker interface, including polling asynchronous video jobs."""

    def config(self, kind):
        prefix = f"{kind.upper()}_PROVIDER_"
        return {
            "base": os.getenv(prefix + "BASE_URL", "").strip(),
            "key": os.getenv(prefix + "API_KEY", "").strip(),
            "model": os.getenv(prefix + "MODEL", "").strip(),
        }

    def available(self, kind):
        if kind not in ("text", "image", "audio", "video"):
            return False
        config = self.config(kind)
        return all(config.values()) and self._valid_base(config["base"])

    @staticmethod
    def _valid_base(base):
        try:
            url = urlsplit(base)
            return bool(
                url.scheme in ("http", "https")
                and url.hostname
                and url.port != 0
                and not url.username
                and not url.password
                and not url.query
                and not url.fragment
            )
        except ValueError:
            return False

    @staticmethod
    def _number_setting(name, default, minimum, maximum):
        try:
            value = float(os.getenv(name, str(default)))
        except ValueError as exc:
            raise RuntimeError("Invalid provider configuration") from exc
        if not math.isfinite(value) or not minimum <= value <= maximum:
            raise RuntimeError("Invalid provider configuration")
        return value

    @staticmethod
    def _remaining(deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Provider generation timed out")
        return remaining

    @classmethod
    def _read_bytes(cls, response, max_bytes, deadline):
        response.raise_for_status()
        try:
            declared_size = int(response.headers.get("content-length", "0"))
        except ValueError as exc:
            raise RuntimeError("Invalid provider media size") from exc
        if declared_size < 0 or declared_size > max_bytes:
            raise RuntimeError("Provider media exceeds size limit")
        data = bytearray()
        for chunk in response.iter_bytes():
            cls._remaining(deadline)
            if len(data) + len(chunk) > max_bytes:
                raise RuntimeError("Provider media exceeds size limit")
            data.extend(chunk)
        cls._remaining(deadline)
        if not data:
            raise RuntimeError("Empty provider response")
        return bytes(data)

    @classmethod
    def _json_request(cls, client, method, url, headers, deadline, payload=None):
        with client.stream(
            method, url, headers=headers, json=payload,
            timeout=min(180, cls._remaining(deadline)),
        ) as response:
            data = cls._read_bytes(response, 1024 * 1024, deadline)
        try:
            result = json.loads(data)
        except (ValueError, UnicodeDecodeError) as exc:
            raise RuntimeError("Invalid provider response") from exc
        if not isinstance(result, dict):
            raise RuntimeError("Invalid provider response")
        return result

    @classmethod
    def _media_request(cls, client, method, url, headers, deadline, max_bytes, payload=None):
        with client.stream(
            method, url, headers=headers, json=payload,
            timeout=min(180, cls._remaining(deadline)),
        ) as response:
            data = cls._read_bytes(response, max_bytes, deadline)
            content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        return data, content_type

    @staticmethod
    def _safe_reference(value):
        if not isinstance(value, str):
            return False
        try:
            url = urlsplit(value)
            host = (url.hostname or "").lower().rstrip(".")
            if (
                url.scheme != "https" or not host or url.port == 0
                or url.username or url.password or url.fragment
                or host == "localhost" or host.endswith((".localhost", ".local", ".internal"))
                or "." not in host
            ):
                return False
            try:
                return ipaddress.ip_address(host).is_global
            except ValueError:
                return True
        except ValueError:
            return False

    def _audio(self, client, base, headers, config, prompt, parameters):
        audio_format = parameters.get("response_format", "mp3")
        if audio_format not in ("mp3", "wav"):
            raise RuntimeError("Unsupported audio format; choose mp3 or wav")
        voice = parameters.get("voice", "alloy")
        if not isinstance(voice, str) or not voice.strip() or len(voice) > 128:
            raise RuntimeError("Invalid audio voice")
        payload = {
            "model": config["model"], "input": prompt, "voice": voice,
            "response_format": audio_format,
        }
        if "speed" in parameters:
            speed = parameters["speed"]
            if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not .25 <= speed <= 4:
                raise RuntimeError("Invalid audio speed")
            payload["speed"] = speed
        deadline = time.monotonic() + 180
        max_bytes = int(self._number_setting("AUDIO_PROVIDER_MAX_BYTES", 32 * 1024 * 1024, 1, 64 * 1024 * 1024))
        data, content_type = self._media_request(
            client, "POST", base + "/audio/speech", headers, deadline, max_bytes, payload,
        )
        if audio_format == "mp3":
            valid_header = data.startswith(b"ID3") or (len(data) >= 2 and data[0] == 0xff and data[1] & 0xe0 == 0xe0)
            valid_type = content_type in ("audio/mpeg", "audio/mp3")
            normalized_type = "audio/mpeg"
        else:
            valid_header = len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"
            valid_type = content_type in ("audio/wav", "audio/wave", "audio/x-wav")
            normalized_type = "audio/wav"
        if not valid_header or not valid_type:
            raise RuntimeError("Invalid provider audio media")
        return {"_audio_bytes": data, "content_type": normalized_type, "extension": audio_format}

    def _video(self, client, base, headers, config, prompt, parameters):
        duration = parameters.get("duration", 4)
        size = parameters.get("size", "1280x720")
        if isinstance(duration, bool) or not isinstance(duration, int) or not 1 <= duration <= 120:
            raise RuntimeError("Invalid video duration")
        if not isinstance(size, str) or not re.fullmatch(r"\d{2,4}x\d{2,4}", size):
            raise RuntimeError("Invalid video size")
        if not all(64 <= int(value) <= 4096 for value in size.split("x")):
            raise RuntimeError("Invalid video size")
        payload = {"model": config["model"], "prompt": prompt, "duration": duration, "size": size}
        if "reference_url" in parameters:
            if not self._safe_reference(parameters["reference_url"]):
                raise RuntimeError("Invalid video reference URL")
            payload["reference_url"] = parameters["reference_url"]
        timeout = self._number_setting("VIDEO_PROVIDER_TIMEOUT_SECONDS", 600, .01, 3600)
        interval = self._number_setting("VIDEO_PROVIDER_POLL_INTERVAL_SECONDS", 2, .01, 30)
        max_bytes = int(self._number_setting("VIDEO_PROVIDER_MAX_BYTES", 128 * 1024 * 1024, 1, 256 * 1024 * 1024))
        deadline = time.monotonic() + timeout
        result = self._json_request(client, "POST", base + "/videos", headers, deadline, payload)
        job_id = result.get("id")
        if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", job_id):
            raise RuntimeError("Invalid provider video job ID")
        job_url = base + "/videos/" + job_id
        while True:
            status = result.get("status")
            if status == "completed":
                break
            if status in ("failed", "cancelled", "canceled", "expired"):
                raise RuntimeError("Provider video generation failed")
            if status not in ("queued", "pending", "in_progress", "processing"):
                raise RuntimeError("Invalid provider video status")
            time.sleep(min(interval, self._remaining(deadline)))
            result = self._json_request(client, "GET", job_url, headers, deadline)
        # Provider-returned download URLs are intentionally never followed.
        data, content_type = self._media_request(
            client, "GET", job_url + "/content", headers, deadline, max_bytes,
        )
        if content_type != "video/mp4" or len(data) < 12 or data[4:8] != b"ftyp":
            raise RuntimeError("Invalid provider video media")
        return {"_video_bytes": data, "content_type": "video/mp4", "extension": "mp4"}

    def generate(self, kind, prompt, parameters):
        if not self.available(kind):
            raise RuntimeError("Provider unavailable")
        config = self.config(kind)
        base = config["base"].rstrip("/")
        headers = {"Authorization": "Bearer " + config["key"]}
        with httpx.Client(timeout=180, follow_redirects=False, trust_env=False) as client:
            if kind in ("audio", "video"):
                operation = self._audio if kind == "audio" else self._video
                try:
                    result = operation(client, base, headers, config, prompt, parameters)
                except httpx.TimeoutException as exc:
                    raise RuntimeError("Provider generation timed out") from exc
                return {**result, "provider": "openai-compatible", "model": config["model"]}
            if kind == "text":
                payload = {"model": config["model"], "messages": [{"role": "user", "content": prompt}]}
                for key in ("temperature", "max_tokens"):
                    if key in parameters:
                        payload[key] = parameters[key]
                response = client.post(base + "/chat/completions", headers=headers, json=payload)
                response.raise_for_status()
                content = response.json()["choices"][0]["message"]["content"]
                if not isinstance(content, str) or not content:
                    raise RuntimeError("Invalid provider response")
                return {"text": content, "provider": "openai-compatible", "model": config["model"]}
            payload = {"model": config["model"], "prompt": prompt, "n": 1, "response_format": "b64_json"}
            for key in ("size", "quality", "style"):
                if key in parameters:
                    payload[key] = parameters[key]
            response = client.post(base + "/images/generations", headers=headers, json=payload)
            response.raise_for_status()
            item = response.json()["data"][0]
            if item.get("b64_json"):
                return {"_image_bytes": base64.b64decode(item["b64_json"], validate=True), "provider": "openai-compatible", "model": config["model"]}
            # Keep URL responses explicit; never fetch arbitrary provider-returned URLs server-side.
            if urlsplit(item.get("url", "")).scheme != "https":
                raise RuntimeError("Invalid image response")
            return {"url": item["url"], "provider": "openai-compatible", "model": config["model"], "external_url": True}
