from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProjectInput(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["series", "episode", "script", "canvas"] = "series"
    genre: Literal["anime", "live", "narration", "redraw"] = "anime"
    description: str = Field(default="", max_length=20000)
    aspect_ratio: str = Field(default="16:9", max_length=30)
    style: str = Field(default="日漫", max_length=120)
    script: str = Field(default="", max_length=1000000)
    settings: dict = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Name cannot be blank")
        return value.strip()


class EpisodeInput(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    position: int = Field(default=0, ge=0)
    script: str = Field(default="", max_length=1000000)
    settings: dict = Field(default_factory=dict)


class ShotInput(StrictModel):
    name: str = Field(default="新分镜", min_length=1, max_length=200)
    episode_id: str | None = None
    position: int = Field(default=0, ge=0)
    prompt: str = Field(default="", max_length=50000)
    dialogue: str = Field(default="", max_length=50000)
    duration: float = Field(default=5, gt=0, le=3600)
    image_url: str | None = None
    video_url: str | None = None
    audio_url: str | None = None
    settings: dict = Field(default_factory=dict)


class AssetInput(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["character", "scene", "prop", "effect", "voice"]
    description: str = Field(default="", max_length=20000)
    url: str = Field(default="", max_length=2000)
    style: str = Field(default="", max_length=120)
    metadata: dict = Field(default_factory=dict)


class CanvasInput(StrictModel):
    nodes: list[dict] = Field(default_factory=list, max_length=5000)
    edges: list[dict] = Field(default_factory=list, max_length=10000)
    viewport: dict = Field(default_factory=lambda: {"x": 0, "y": 0, "zoom": 1})
    revision: int = Field(ge=0)


class TaskInput(StrictModel):
    kind: Literal["text", "image", "video", "audio", "export"]
    project_id: str | None = None
    prompt: str = Field(default="", max_length=100000)
    parameters: dict = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=1, max_length=128)


class ProfileInput(StrictModel):
    name: str = Field(min_length=1, max_length=120)


class ParseInput(StrictModel):
    script: str | None = Field(default=None, max_length=1000000)
