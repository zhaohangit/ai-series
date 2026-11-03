"""Private media storage; access is always checked against upload ownership by the API."""
import os
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from fastapi import HTTPException
from fastapi.responses import FileResponse, StreamingResponse


class MediaStorage:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        endpoint = os.getenv("S3_ENDPOINT_URL")
        self.bucket = os.getenv("S3_BUCKET", "dramabuddy-media")
        self.client = None
        if endpoint:
            self.client = boto3.client("s3", endpoint_url=endpoint, aws_access_key_id=os.environ["S3_ACCESS_KEY"], aws_secret_access_key=os.environ["S3_SECRET_KEY"], region_name=os.getenv("S3_REGION", "us-east-1"), config=Config(signature_version="s3v4", s3={"addressing_style": "path"}, connect_timeout=5, read_timeout=60, retries={"max_attempts": 2}))

    def prepare(self):
        if self.client:
            try:
                self.client.head_bucket(Bucket=self.bucket)
            except ClientError as error:
                if error.response["Error"]["Code"] not in ("404", "NoSuchBucket", "NotFound"):
                    raise RuntimeError("Configured object storage unavailable") from None
                self.client.create_bucket(Bucket=self.bucket)

    def local_path(self, key):
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root) or key.startswith("/") or ".." in Path(key).parts:
            raise HTTPException(404, "Media not found")
        return path

    def put(self, key, data, content_type):
        path = self.local_path(key)
        if self.client:
            self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def read(self, key):
        path = self.local_path(key)
        if self.client:
            body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"]
            try:
                return body.read()
            finally:
                body.close()
        return path.read_bytes()

    def response(self, key, content_type, request=None):
        path = self.local_path(key)
        headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"}
        safe_inline = ("image/png", "image/jpeg", "image/webp", "image/gif", "audio/mpeg", "audio/wav", "video/mp4", "application/json")
        if content_type not in safe_inline:
            headers["Content-Disposition"] = "attachment"
        if self.client:
            options = {"Bucket": self.bucket, "Key": key}
            range_header = request.headers.get("range") if request else None
            if range_header:
                options["Range"] = range_header
            try:
                result = self.client.get_object(**options)
            except ClientError as error:
                code = error.response["Error"]["Code"]
                raise HTTPException(416 if code == "InvalidRange" else 404, "Media range unavailable" if code == "InvalidRange" else "Media not found") from None
            body = result["Body"]
            headers["Content-Length"] = str(result["ContentLength"])
            headers["Accept-Ranges"] = "bytes"
            if result.get("ContentRange"):
                headers["Content-Range"] = result["ContentRange"]

            def stream():
                try:
                    yield from body.iter_chunks(chunk_size=1024 * 256)
                finally:
                    body.close()
            return StreamingResponse(stream(), media_type=content_type, headers=headers, status_code=206 if result.get("ContentRange") else 200)
        if not path.is_file():
            raise HTTPException(404, "Media not found")
        return FileResponse(path, media_type=content_type, headers=headers)
