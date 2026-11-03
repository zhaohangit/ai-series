"""Create local-only random credentials without printing secret values."""
from pathlib import Path
import secrets
import os

root = Path(__file__).resolve().parent.parent
target = root / '.env'
if target.exists():
    print('.env already exists; retained unchanged')
else:
    values = { 'POSTGRES_PASSWORD': secrets.token_hex(24), 'MINIO_PASSWORD': secrets.token_hex(24), 'SESSION_SECRET': secrets.token_hex(32) }
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write('\n'.join(f'{key}={value}' for key, value in values.items()) + '\n')
    print('Created private local .env')
