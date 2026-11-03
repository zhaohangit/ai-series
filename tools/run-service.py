"""Run one local service against the isolated OrbStack dependencies."""
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parent.parent
env = dict(os.environ)
for line in (root / '.env').read_text().splitlines():
    if line.strip() and not line.lstrip().startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        env[key] = value
env.update({
    'DATABASE_URL': f"postgresql+psycopg://series:{env['POSTGRES_PASSWORD']}@127.0.0.1:25432/series",
    'REDIS_URL': 'redis://127.0.0.1:26379/0',
    'TASK_EXECUTOR': 'celery',
    'MEDIA_ROOT': str(root / 'data/media'),
    'S3_ENDPOINT_URL': 'http://127.0.0.1:29000',
    'S3_ACCESS_KEY': 'series-local',
    'S3_SECRET_KEY': env['MINIO_PASSWORD'],
    'S3_BUCKET': 'series-media',
})
service = sys.argv[1] if len(sys.argv) > 1 else 'api'
if service == 'api':
    os.chdir(root / 'backend')
    cmd = [str(root / 'backend/.venv/bin/uvicorn'), 'app.main:app', '--host', '127.0.0.1', '--port', '8001']
elif service == 'worker':
    os.chdir(root / 'backend')
    cmd = [str(root / 'backend/.venv/bin/celery'), '-A', 'app.worker.celery_app', 'worker', '--loglevel=warning', '--concurrency=2', '--pool=solo']
elif service == 'web':
    os.chdir(root / 'web')
    cmd = ['npm', 'run', 'dev']
else:
    raise SystemExit('Usage: python tools/run-service.py api|worker|web')
os.execvpe(cmd[0], cmd, env)
