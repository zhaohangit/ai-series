"""Run integration tests with private local credentials and isolated test resources."""
from pathlib import Path
import os
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
env = dict(os.environ)
private = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
env.update({
    'TEST_DATABASE_URL': f"postgresql+psycopg://series:{private['POSTGRES_PASSWORD']}@127.0.0.1:25432/series",
    'TEST_REDIS_URL': 'redis://127.0.0.1:26379/0',
    'TEST_S3_ENDPOINT_URL': 'http://127.0.0.1:29000',
    'TEST_S3_ACCESS_KEY': 'series-local',
    'TEST_S3_SECRET_KEY': private['MINIO_PASSWORD'],
})
cmd = [str(root / 'backend/.venv/bin/python'), '-m', 'pytest', '-q', *sys.argv[1:]]
raise SystemExit(subprocess.run(cmd, cwd=root / 'backend', env=env).returncode)
