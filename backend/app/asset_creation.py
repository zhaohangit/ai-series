"""Durable optional request keys for retried material imports."""
from copy import deepcopy
import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import ForeignKey, String, UniqueConstraint, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from .models import Asset, Base, now, uid


class AssetCreationRequest(Base):
    __tablename__ = "asset_creation_requests"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    # Intentionally retained after Asset deletion: a replay must return 410,
    # never resurrect deleted material by cascading away its request record.
    asset_id: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    __table_args__ = (UniqueConstraint("owner_id", "idempotency_key"),)


def create_asset_record(session, owner_id, data, key=None):
    """Create and commit an Asset, or replay this owner's identical request."""
    if key is None:
        asset = Asset(owner_id=owner_id, data=deepcopy(data))
        session.add(asset)
        session.commit()
        return asset
    if not isinstance(key, str) or not 1 <= len(key) <= 128:
        raise HTTPException(422, "Idempotency-Key must contain 1 to 128 characters")
    try:
        canonical = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (ValueError, TypeError):
        raise HTTPException(422, "Invalid asset payload") from None
    fingerprint = hashlib.sha256(canonical.encode()).hexdigest()
    query = select(AssetCreationRequest).where(
        AssetCreationRequest.owner_id == owner_id,
        AssetCreationRequest.idempotency_key == key,
    )

    def replay(request):
        if request.request_hash != fingerprint:
            raise HTTPException(409, "Idempotency key already used for a different asset request")
        asset = session.scalar(select(Asset).where(Asset.id == request.asset_id, Asset.owner_id == owner_id))
        if asset is None:
            raise HTTPException(410, "Imported asset was deleted; use a new idempotency key for a new import")
        return asset

    existing = session.scalar(query)
    if existing is not None:
        return replay(existing)
    asset = Asset(id=uid(), owner_id=owner_id, data=deepcopy(data))
    session.add(asset)
    session.add(AssetCreationRequest(owner_id=owner_id, idempotency_key=key,
                                     request_hash=fingerprint, asset_id=asset.id))
    try:
        session.commit()
    except IntegrityError:
        # A racing winner may commit the key while this transaction inserts its
        # asset. Roll back both losing rows before reading the winner's record.
        session.rollback()
        existing = session.scalar(query)
        if existing is None:
            raise
        return replay(existing)
    return asset
