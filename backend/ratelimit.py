"""Per-user sliding-window rate limiting.

In-process only, which is the right scope for a single-instance deployment.
Behind several replicas each one enforces the limit independently - swap the
store for Redis if that ever changes.
"""
import time
from collections import defaultdict, deque

from fastapi import HTTPException, status

_buckets: dict[str, deque[float]] = defaultdict(deque)
_last_sweep = 0.0


def _sweep(now: float) -> None:
    """Drop buckets nobody has touched for a while so memory stays flat."""
    global _last_sweep
    if now - _last_sweep < 300:
        return
    _last_sweep = now
    for key in [k for k, hits in _buckets.items() if not hits or now - hits[-1] > 3600]:
        _buckets.pop(key, None)


def check(key: str, limit: int, window_seconds: int) -> None:
    """Record a hit for `key`, or raise 429 when the window is full."""
    now = time.monotonic()
    _sweep(now)

    hits = _buckets[key]
    cutoff = now - window_seconds
    while hits and hits[0] < cutoff:
        hits.popleft()

    if len(hits) >= limit:
        retry_after = max(1, int(hits[0] + window_seconds - now) + 1)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests. Please slow down and try again shortly.",
            headers={"Retry-After": str(retry_after)},
        )

    hits.append(now)


def reset() -> None:
    """Test helper."""
    _buckets.clear()
