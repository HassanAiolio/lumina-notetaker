"""Summaries as background jobs that the app polls.

A two hour lecture is several model calls in a row, each of which may be
retried or handed to another model, so writing its notes can take longer than
anyone should hold an HTTP request open: the browser gave up at ten minutes,
the server finished anyway, and the notes were thrown away with the quota they
cost. Now a request starts the work and returns at once, and the app asks how
it is going until it is done.

In-process, like the rate limiter: right for a single instance. A restart loses
the jobs that were running, and the app says so and offers to try again.
"""
import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from config import settings

logger = logging.getLogger(__name__)

RUNNING, DONE, FAILED = "running", "done", "failed"


@dataclass
class Job:
    id: str
    user_id: str
    status: str = RUNNING
    stage: str = "starting"
    done: int = 0
    total: int = 0
    result: dict | None = None
    error: str | None = None
    finished_at: float | None = None
    task: asyncio.Task | None = field(default=None, repr=False)

    def report(self, stage: str, done: int, total: int) -> None:
        self.stage, self.done, self.total = stage, done, total

    def public(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "progress": {"stage": self.stage, "done": self.done, "total": self.total},
            "result": self.result,
            "error": self.error,
        }


_jobs: dict[str, Job] = {}


def _sweep() -> None:
    """Forget finished jobs nobody has collected for a while."""
    cutoff = time.monotonic() - settings.SUMMARY_JOB_TTL
    for job_id in [j.id for j in _jobs.values() if j.finished_at and j.finished_at < cutoff]:
        _jobs.pop(job_id, None)


def running_for(user_id: str) -> int:
    return sum(1 for job in _jobs.values() if job.user_id == user_id and job.status == RUNNING)


def start(user_id: str, work) -> Job:
    """Run `work(report)` in the background; `report(stage, done, total)` updates the job."""
    _sweep()
    job = Job(id=str(uuid.uuid4()), user_id=user_id)

    async def run() -> None:
        try:
            job.result = await asyncio.wait_for(work(job.report), settings.SUMMARY_JOB_DEADLINE)
            job.status = DONE
        except asyncio.TimeoutError:
            minutes = int(settings.SUMMARY_JOB_DEADLINE // 60)
            job.error = f"Writing these notes took longer than {minutes} minutes and was stopped. Try again later."
            job.status = FAILED
            logger.error("Summary job %s passed its deadline", job.id)
        except Exception:  # noqa: BLE001 - reported to the app, never raised into the loop
            job.error = "Something went wrong while writing your notes. Please try again."
            job.status = FAILED
            logger.exception("Summary job %s failed", job.id)
        finally:
            job.finished_at = time.monotonic()

    _jobs[job.id] = job
    job.task = asyncio.create_task(run())
    return job


def get(job_id: str, user_id: str) -> Job | None:
    """The job, if it exists and belongs to this user."""
    job = _jobs.get(job_id)
    return job if job and job.user_id == user_id else None


def reset() -> None:
    """For tests: cancel and forget every job."""
    for job in _jobs.values():
        if job.task and not job.task.done():
            job.task.cancel()
    _jobs.clear()
