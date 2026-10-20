"""Runtime settings, read once from the Lambda environment (set by Terraform)."""
import os

TABLE_NAME = os.environ.get("TABLE_NAME", "")
UPLOAD_BUCKET = os.environ.get("UPLOAD_BUCKET", "")
VALIDATE_QUEUE_URL = os.environ.get("VALIDATE_QUEUE_URL", "")
EXTRACT_QUEUE_URL = os.environ.get("EXTRACT_QUEUE_URL", "")
ALERTS_TOPIC_ARN = os.environ.get("ALERTS_TOPIC_ARN", "")
GEMINI_KEY_PARAM = os.environ.get("GEMINI_KEY_PARAM", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
APP_URL = os.environ.get("APP_URL", "")

DEFAULT_THRESHOLD_PCT = float(os.environ.get("DEFAULT_THRESHOLD_PCT", "5"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))
MAX_RECEIVES = int(os.environ.get("MAX_RECEIVES", "3"))

ALLOWED_CONTENT_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
}
