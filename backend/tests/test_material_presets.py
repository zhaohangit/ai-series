"""The public preset catalogue must retain observed identities and local media."""
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

from test_api import client


PUBLIC_ROOT = Path(__file__).resolve().parents[2] / "web" / "public"
COLLECTION_TOTALS = {"character": 14, "scene": 14, "prop": 14, "effect": 19}
ITEM_TOTALS = {"character": 146, "scene": 97, "prop": 79, "effect": 139}


def catalogue(client):
    response = client.get("/api/material-presets")
    assert response.status_code == 200, response.text
    return response.json()


def test_merged_catalogue_retains_kind_counts_and_observed_identities(client):
    collections = catalogue(client)["collections"]
    assert Counter(row["kind"] for row in collections) == COLLECTION_TOTALS
    totals = Counter()
    collection_keys = set()
    material_keys = set()
    for collection in collections:
        assert isinstance(collection["id"], str)
        key = collection["kind"], collection["id"]
        assert key not in collection_keys
        collection_keys.add(key)
        assert collection["count"] == collection["material_count"] == len(collection["items"])
        totals[collection["kind"]] += len(collection["items"])
        for item in collection["items"]:
            assert isinstance(item["id"], str)
            assert item["kind"] == collection["kind"]
            identity = item["kind"], item["id"]
            assert identity not in material_keys
            material_keys.add(identity)
    assert totals == ITEM_TOTALS
    by_identity = {(row["kind"], row["id"]): row for row in collections}
    assert by_identity["character", "101"]["items"][0]["name"] == "小邪童"
    assert by_identity["scene", "101"]["items"][0]["name"] == "洞窟寺庙"
    assert by_identity["prop", "2001648959160672256"]["items"][0]["name"] == "龙甲刀"
    assert by_identity["effect", "2001648962390286336"]["items"][0]["name"] == "聚灵回春阵"


def test_catalogue_covers_and_main_images_are_real_local_static_files(client):
    for collection in catalogue(client)["collections"]:
        for material in [collection, *collection["items"]]:
            url = material["url"]
            parsed = urlsplit(url)
            assert not parsed.scheme and not parsed.netloc and not parsed.query and not parsed.fragment
            assert parsed.path.startswith("/reference/")
            assert ".." not in Path(parsed.path).parts
            image_path = PUBLIC_ROOT / parsed.path.lstrip("/")
            assert image_path.is_file(), material["name"]
            image = material["metadata"]["image"]
            assert not image.get("uncached"), material["name"]
            assert image_path.stat().st_size == image["bytes"] > 0
            assert image["content_type"].startswith("image/")
            assert len(image["sha256"]) == 64


def test_public_catalogue_never_exports_signed_source_queries(client):
    def check(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "source_path":
                    parsed = urlsplit(child)
                    assert parsed.scheme == "https" and parsed.netloc
                    assert not parsed.query and not parsed.fragment
                check(child)
        elif isinstance(value, list):
            for child in value:
                check(child)
        elif isinstance(value, str) and value.startswith(("http://", "https://", "/reference/")):
            parsed = urlsplit(value)
            assert not parsed.query and not parsed.fragment
    check(catalogue(client))


def test_uncached_scene_gallery_is_explicit_and_not_presented_as_main_media(client):
    scenes = [row for row in catalogue(client)["collections"] if row["kind"] == "scene"]
    gallery = [entry for row in scenes for item in row["items"] for entry in item["metadata"]["gallery"]]
    assert len(gallery) == 945
    assert all(entry["uncached"] and entry["reason"] == "gallery_not_requested" and not entry.get("url") for entry in gallery)
    assert all(entry["image"]["source_path"] == entry["source_path"] for entry in gallery)
