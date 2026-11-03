import os

from celery import Celery

celery_app = Celery("dramabuddy", broker=os.getenv("REDIS_URL", "redis://localhost:26379/0"))
celery_app.conf.update(task_serializer="json", accept_content=["json"], result_serializer="json", task_ignore_result=True, worker_prefetch_multiplier=1, broker_connection_retry_on_startup=True, task_default_queue=os.getenv("CELERY_QUEUE", "dramabuddy"), broker_transport_options={"visibility_timeout": int(os.getenv("CELERY_VISIBILITY_TIMEOUT", "3600"))})


@celery_app.task(bind=True, name="dramabuddy.execute_task", acks_late=True, reject_on_worker_lost=True, max_retries=10)
def run_task(self, task_id):
    from .main import app, execute_task
    from sqlalchemy.exc import OperationalError
    try:
        execute_task(app, task_id, recover_interrupted=bool(self.request.delivery_info.get("redelivered") or self.request.retries))
    except OperationalError:
        raise self.retry(exc=RuntimeError("Database temporarily unavailable"), countdown=10) from None
