"""Extract Lambda (outside the VPC, so it can call the Gemini API without a NAT gateway).

Input: S3 ObjectCreated events delivered through the extract queue.
Reads the uploaded photo/PDF, asks Gemini for structured JSON and forwards the
result to the validate queue. Failures are retried by SQS with growing delays;
after the last attempt the invoice is marked failed and the message goes to the DLQ.
"""
import json
import logging
import urllib.parse
from datetime import datetime, timezone

from supplyradar import aws, config, db, gemini

log = logging.getLogger()
log.setLevel(logging.INFO)

EXT_TO_MIME = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
               "webp": "image/webp", "pdf": "application/pdf"}
DONE = ("checked", "needs_review", "confirming", "confirmed")


def handler(event, context):
    failures = []
    for record in event.get("Records", []):
        attempt = int(record.get("attributes", {}).get("ApproximateReceiveCount", "1"))
        try:
            body = json.loads(record["body"])
            if body.get("Event") == "s3:TestEvent":
                continue
            for s3rec in body.get("Records", []):
                bucket = s3rec["s3"]["bucket"]["name"]
                key = urllib.parse.unquote_plus(s3rec["s3"]["object"]["key"])
                process(bucket, key, attempt)
        except Exception as err:
            log.exception("extract failed (attempt %d)", attempt)
            failures.append({"itemIdentifier": record["messageId"]})
            back_off(record, attempt, err)
    return {"batchItemFailures": failures}


def parse_key(key):
    """uploads/<user_id>/<invoice_id>.<ext> -> (user_id, invoice_id, ext)"""
    parts = key.split("/")
    if len(parts) != 3 or parts[0] != "uploads" or "." not in parts[2]:
        raise ValueError(f"unexpected object key {key}")
    invoice_id, ext = parts[2].rsplit(".", 1)
    return parts[1], invoice_id, ext.lower()


def set_status(user_id, invoice_id, status, **extra):
    store = db.store()
    pk = db.user_pk(user_id)
    item = store.get(pk, f"INV#{invoice_id}")
    if item is None or item.get("status") in DONE:
        return False
    item.update(status=status, updated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **extra)
    store.put(item)
    return True


def process(bucket, key, attempt):
    user_id, invoice_id, ext = parse_key(key)
    if ext not in EXT_TO_MIME:
        raise ValueError(f"unsupported file type {ext}")
    if not set_status(user_id, invoice_id, "extracting"):
        log.warning("no pending invoice record for %s, ignoring upload", key)
        return

    obj = aws.client("s3").get_object(Bucket=bucket, Key=key)
    if obj["ContentLength"] > config.MAX_UPLOAD_BYTES:
        set_status(user_id, invoice_id, "failed", error="Файл слишком большой")
        return
    data = obj["Body"].read()

    extraction = gemini.extract_invoice(data, EXT_TO_MIME[ext])
    log.info("extracted %d lines from %s", len(extraction.get("lines", [])), key)

    # Status first: the validate function may finish before send_message returns.
    set_status(user_id, invoice_id, "validating")
    aws.client("sqs").send_message(
        QueueUrl=config.VALIDATE_QUEUE_URL,
        MessageBody=json.dumps({"user_id": user_id, "invoice_id": invoice_id, "extraction": extraction}),
    )


def back_off(record, attempt, err):
    """Delay the next retry (60 s, 120 s, ...) and mark the invoice failed on the last one."""
    if attempt >= config.MAX_RECEIVES:
        try:
            body = json.loads(record["body"])
            for s3rec in body.get("Records", []):
                user_id, invoice_id, _ = parse_key(urllib.parse.unquote_plus(s3rec["s3"]["object"]["key"]))
                set_status(user_id, invoice_id, "failed", error="AI не смог прочитать накладную")
        except Exception:
            log.exception("could not mark invoice failed")
        return
    delay = 60 * attempt * (3 if isinstance(err, gemini.GeminiRateLimited) else 1)
    try:
        aws.client("sqs").change_message_visibility(
            QueueUrl=config.EXTRACT_QUEUE_URL,
            ReceiptHandle=record["receiptHandle"],
            VisibilityTimeout=min(delay, 900),
        )
    except Exception:
        log.exception("could not change visibility")
