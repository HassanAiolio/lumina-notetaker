"""Google Sign-In verification and app session tokens."""
import logging
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from config import settings
from db import get_db

logger = logging.getLogger(__name__)

# Reused across verifications so the HTTP session (and its connection pool)
# is not rebuilt on every sign-in.
_google_request = google_requests.Request()

bearer_scheme = HTTPBearer(auto_error=False)


class User:
    __slots__ = ("id", "email", "name", "picture")

    def __init__(self, id: str, email: str, name: str = "", picture: str = ""):
        self.id = id
        self.email = email
        self.name = name
        self.picture = picture

    def public(self) -> dict:
        return {"id": self.id, "email": self.email, "name": self.name, "picture": self.picture}


def _email_allowed(email: str) -> bool:
    """Empty allow-lists mean the app is open to any Google account."""
    if not settings.ALLOWED_EMAILS and not settings.ALLOWED_EMAIL_DOMAINS:
        return True
    email = email.lower()
    if email in settings.ALLOWED_EMAILS:
        return True
    domain = email.rsplit("@", 1)[-1]
    return domain in settings.ALLOWED_EMAIL_DOMAINS


def _verify_google_credential_sync(credential: str) -> dict:
    return google_id_token.verify_oauth2_token(
        credential,
        _google_request,
        settings.GOOGLE_CLIENT_ID,
        # Google's own clock can drift a little against ours; without this a
        # freshly issued token is occasionally rejected as "used too early".
        clock_skew_in_seconds=10,
    )


async def verify_google_credential(credential: str) -> dict:
    """Validate a Google ID token and return its claims, or raise 401."""
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google Sign-In is not configured on this server (GOOGLE_CLIENT_ID missing)",
        )
    try:
        claims = await run_in_threadpool(_verify_google_credential_sync, credential)
    except ValueError as exc:
        logger.warning("Rejected Google credential: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Google credential"
        ) from exc
    except Exception as exc:  # noqa: BLE001 - network failure reaching Google
        logger.error("Google credential verification failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not reach Google to verify your sign-in. Please try again.",
        ) from exc

    if claims.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token issuer")
    if not claims.get("email"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Google account has no email")
    if not claims.get("email_verified", False):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Google email is not verified")
    if not _email_allowed(claims["email"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account is not allowed to use this app",
        )
    return claims


async def upsert_user(claims: dict) -> User:
    """Create or refresh the local user record keyed on the Google subject id."""
    db = get_db()
    google_sub = claims["sub"]
    email = claims["email"].lower()
    now = datetime.now(timezone.utc).isoformat()

    existing = await db.users.find_one({"google_sub": google_sub}, {"_id": 0})
    if existing is None:
        # Same person, previously seen under another identity provider record.
        existing = await db.users.find_one({"email": email}, {"_id": 0})

    user_id = existing["id"] if existing else str(uuid.uuid4())
    doc = {
        "id": user_id,
        "google_sub": google_sub,
        "email": email,
        "name": claims.get("name", "") or email.split("@")[0],
        "picture": claims.get("picture", ""),
        "last_login_at": now,
    }
    await db.users.update_one(
        {"id": user_id},
        {"$set": doc, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )
    return User(id=user_id, email=email, name=doc["name"], picture=doc["picture"])


def issue_access_token(user: User) -> tuple[str, int]:
    """Return (token, expires_in_seconds)."""
    ttl = timedelta(days=settings.JWT_TTL_DAYS)
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user.id,
        "email": user.email,
        "name": user.name,
        "picture": user.picture,
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    return token, int(ttl.total_seconds())


async def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> User:
    """FastAPI dependency: the signed-in user, or 401."""
    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not signed in",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = jwt.decode(
            credentials.credentials,
            settings.JWT_SECRET,
            algorithms=[settings.JWT_ALGORITHM],
        )
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired, please sign in again",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    return User(
        id=payload["sub"],
        email=payload.get("email", ""),
        name=payload.get("name", ""),
        picture=payload.get("picture", ""),
    )
