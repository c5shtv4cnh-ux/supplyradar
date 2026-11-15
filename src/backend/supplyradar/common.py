"""Pieces shared by the API handlers."""
from datetime import datetime, timezone


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def num(value, field, required=True):
    if value in (None, ""):
        if required:
            raise ApiError(400, f"Поле {field} обязательно")
        return None
    try:
        return float(str(value).replace(" ", "").replace(",", "."))
    except ValueError:
        raise ApiError(400, f"Поле {field} должно быть числом")
