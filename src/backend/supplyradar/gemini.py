"""Minimal Gemini API client (REST, standard library only, so Lambda needs no layer).

The API key lives in SSM Parameter Store as a SecureString and is read once per
container. For local evaluation the GEMINI_API_KEY environment variable wins.
"""
import base64
import json
import os
import urllib.error
import urllib.request

from . import config

API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class GeminiError(Exception):
    """Any failure talking to the model. SQS retries the message."""


class GeminiRateLimited(GeminiError):
    """HTTP 429: the free-tier quota is exhausted for now."""


INVOICE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "supplier_name": {"type": "STRING", "nullable": True},
        "supplier_bin": {
            "type": "STRING",
            "nullable": True,
            "description": "Supplier BIN/IIN, 12 digits, digits only",
        },
        "invoice_number": {"type": "STRING", "nullable": True},
        "invoice_date": {"type": "STRING", "nullable": True, "description": "YYYY-MM-DD"},
        "currency": {"type": "STRING", "nullable": True, "description": "ISO code, e.g. KZT"},
        "total": {"type": "NUMBER", "nullable": True},
        "lines": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "name": {"type": "STRING", "description": "Name exactly as printed"},
                    "canonical_name": {"type": "STRING"},
                    "quantity": {"type": "NUMBER", "nullable": True},
                    "unit": {"type": "STRING", "nullable": True},
                    "price": {"type": "NUMBER", "nullable": True},
                    "total": {"type": "NUMBER", "nullable": True},
                },
                "required": ["name", "canonical_name", "quantity", "unit", "price", "total"],
                "propertyOrdering": ["name", "canonical_name", "quantity", "unit", "price", "total"],
            },
        },
    },
    "required": [
        "supplier_name", "supplier_bin", "invoice_number",
        "invoice_date", "currency", "total", "lines",
    ],
    "propertyOrdering": [
        "supplier_name", "supplier_bin", "invoice_number",
        "invoice_date", "currency", "total", "lines",
    ],
}

EXTRACT_PROMPT = """You read supplier invoices (накладные, счета-фактуры) for small food businesses
in Kazakhstan and Russia. Return the data exactly as printed on the document.

Rules:
- Copy numbers as printed. Never recompute, round or "fix" a number, even if it looks wrong.
- Numbers: dot as decimal separator, no thousands separators or spaces, no currency signs.
- invoice_date: convert to YYYY-MM-DD.
- supplier_bin: the 12-digit БИН/ИИН of the seller (поставщик), digits only.
- total: the grand total (Итого / Всего к оплате) printed on the invoice.
- One entry in lines per product row. Skip subtotal, VAT and delivery rows.
- price is the price per one unit; total is the row amount.
- canonical_name: the product in Russian, lowercase, in a standard form:
  product type, key attributes (fat %, grade), package size with unit.
  Examples: "МОЛОКО 3,2 1Л" -> "молоко 3.2% 1 л"; "Slivki 33% 0.5L" -> "сливки 33% 0.5 л".
- If a value is unreadable or missing, use null. Do not guess.
"""


_api_key = None


def api_key():
    global _api_key
    if _api_key:
        return _api_key
    if os.environ.get("GEMINI_API_KEY"):
        _api_key = os.environ["GEMINI_API_KEY"]
        return _api_key
    import boto3

    resp = boto3.client("ssm").get_parameter(Name=config.GEMINI_KEY_PARAM, WithDecryption=True)
    _api_key = resp["Parameter"]["Value"]
    return _api_key


def _post(model, payload, timeout):
    req = urllib.request.Request(
        API_URL.format(model=model),
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key()},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:500]
        if err.code == 429:
            raise GeminiRateLimited(detail) from err
        raise GeminiError(f"HTTP {err.code}: {detail}") from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise GeminiError(f"network error: {err}") from err


def response_text(body):
    """Return the text of the first candidate or raise GeminiError."""
    feedback = body.get("promptFeedback") or {}
    if feedback.get("blockReason"):
        raise GeminiError(f"prompt blocked: {feedback['blockReason']}")
    candidates = body.get("candidates") or []
    if not candidates:
        raise GeminiError("no candidates in response")
    cand = candidates[0]
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    if not text:
        raise GeminiError(f"empty response, finishReason={cand.get('finishReason')}")
    return text


def generate(parts, schema=None, model=None, temperature=0.0, timeout=50):
    config_block = {"temperature": temperature}
    if schema:
        config_block["responseMimeType"] = "application/json"
        config_block["responseSchema"] = schema
    payload = {"contents": [{"role": "user", "parts": parts}], "generationConfig": config_block}
    return response_text(_post(model or config.GEMINI_MODEL, payload, timeout))


def extract_invoice(data, mime_type, model=None):
    """Send an invoice image or PDF, get the structured fields back as a dict."""
    parts = [
        {"inline_data": {"mime_type": mime_type, "data": base64.b64encode(data).decode()}},
        {"text": EXTRACT_PROMPT},
    ]
    text = generate(parts, schema=INVOICE_SCHEMA, model=model)
    try:
        result = json.loads(text)
    except json.JSONDecodeError as err:
        raise GeminiError(f"model returned invalid JSON: {text[:200]}") from err
    if not isinstance(result, dict) or not isinstance(result.get("lines"), list):
        raise GeminiError("model returned JSON without lines")
    return result


def write_text(prompt, model=None, temperature=0.3):
    return generate([{"text": prompt}], model=model, temperature=temperature).strip()
