import os
import hmac
import hashlib
import secrets
from typing import Optional
from fastapi import Request, HTTPException, status
from fastapi.responses import RedirectResponse

# Configuration from environment variables
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
AUTH_SECRET = os.getenv("AUTH_SECRET", secrets.token_hex(32))

COOKIE_NAME = "lingolive_session"


def is_auth_enabled() -> bool:
    """Authentication is enabled if ADMIN_PASSWORD is set and non-empty."""
    return bool(ADMIN_PASSWORD and ADMIN_PASSWORD.strip())


def generate_auth_token() -> str:
    """Generates a verifiable HMAC token for QR code auto-login."""
    payload = f"{ADMIN_USERNAME}:{ADMIN_PASSWORD}".encode("utf-8")
    return hmac.new(AUTH_SECRET.encode("utf-8"), payload, hashlib.sha256).hexdigest()[:32]


def verify_auth_token(token: str) -> bool:
    """Verifies if the provided token matches the secret HMAC token."""
    if not is_auth_enabled():
        return True
    expected = generate_auth_token()
    return hmac.compare_digest(expected, token)


def verify_login(username: str, password: str) -> bool:
    """Verifies username and password securely against timing attacks."""
    if not is_auth_enabled():
        return True
    user_ok = hmac.compare_digest(username.strip(), ADMIN_USERNAME.strip())
    pass_ok = hmac.compare_digest(password.strip(), ADMIN_PASSWORD.strip())
    return user_ok and pass_ok


def is_authenticated(request: Request) -> bool:
    """Checks if request has a valid session cookie or URL query token."""
    if not is_auth_enabled():
        return True

    # 1. Check URL query token (?token=...)
    query_token = request.query_params.get("token")
    if query_token and verify_auth_token(query_token):
        return True

    # 2. Check session cookie
    cookie_token = request.cookies.get(COOKIE_NAME)
    if cookie_token and verify_auth_token(cookie_token):
        return True

    return False
