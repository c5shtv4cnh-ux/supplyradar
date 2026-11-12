"""API Lambda behind API Gateway HTTP API (JWT authorizer = Cognito).

Routes (all require a valid Cognito ID token):
    POST /uploads                 create invoice record + presigned S3 POST
    GET  /invoices                latest invoices
    GET  /invoices/{id}           one invoice + temporary link to the original file
    PUT  /invoices/{id}           human review: corrected fields, confirm
    GET  /products                products with latest prices per supplier
    GET  /products/{key}          price history of one product
    GET  /alerts                  latest price alerts
    GET  /settings                alert threshold, email, business profile, is_admin
    PUT  /settings                change threshold / email (subscribes email to SNS) / business profile
    GET  /admin/overview          service-wide numbers, admin accounts only
"""
import json
import logging
import re
import urllib.parse
import uuid
from datetime import datetime, timezone

from supplyradar import aws, config, db

log = logging.getLogger()
log.setLevel(logging.INFO)

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
REVIEWABLE = ("needs_review", "checked", "failed")
# Business templates offered at sign-up. The web app holds the texts; the API only validates the key.
BUSINESS_TYPES = ("cafe", "restaurant", "shop", "bakery", "other")


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps(db.from_db(body), ensure_ascii=False),
    }


def handler(event, context):
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
        user = {"id": claims["sub"], "email": claims.get("email")}
        user["is_admin"] = str(claims.get("email_verified")).lower() == "true" \
            and (user["email"] or "").lower() in config.ADMIN_EMAILS
        route = ROUTES.get(event.get("routeKey"))
        if route is None:
            raise ApiError(404, "Not found")
        params = {k: urllib.parse.unquote(v) for k, v in (event.get("pathParameters") or {}).items()}
        body = parse_body(event)
        return response(200, route(user, params, body))
    except ApiError as err:
        return response(err.status, {"error": err.message})
    except Exception:
        log.exception("unhandled error on %s", event.get("routeKey"))
        return response(500, {"error": "Internal error"})


def parse_body(event):
    raw = event.get("body")
    if not raw:
        return {}
    if event.get("isBase64Encoded"):
        import base64
        raw = base64.b64decode(raw).decode()
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        raise ApiError(400, "Body must be JSON")
    if not isinstance(body, dict):
        raise ApiError(400, "Body must be a JSON object")
    return body


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- uploads and invoices ----------

def create_upload(user, params, body):
    content_type = body.get("content_type")
    ext = config.ALLOWED_CONTENT_TYPES.get(content_type)
    if not ext:
        raise ApiError(400, "Поддерживаются только JPEG, PNG, WEBP и PDF")
    created = now_iso()
    # Time-ordered id: newest invoices come first in a descending query.
    invoice_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:8]
    key = f"uploads/{user['id']}/{invoice_id}.{ext}"
    db.store().put({
        "PK": db.user_pk(user["id"]),
        "SK": f"INV#{invoice_id}",
        "invoice_id": invoice_id,
        "user_id": user["id"],
        "status": "uploading",
        "file_key": key,
        "content_type": content_type,
        "file_name": str(body.get("file_name") or "")[:200],
        "created_at": created,
    })
    post = aws.client("s3").generate_presigned_post(
        Bucket=config.UPLOAD_BUCKET,
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[{"Content-Type": content_type}, ["content-length-range", 1, config.MAX_UPLOAD_BYTES]],
        ExpiresIn=300,
    )
    return {"invoice_id": invoice_id, "upload": post}


SUMMARY_FIELDS = ("invoice_id", "status", "supplier_name", "invoice_number", "invoice_date",
                  "total", "currency", "created_at", "file_name")


def list_invoices(user, params, body):
    items = db.store().query_prefix(db.user_pk(user["id"]), "INV#", newest_first=True, limit=50)
    return {"invoices": [
        {**{f: i.get(f) for f in SUMMARY_FIELDS}, "issues": len(i.get("issues") or []),
         "lines": len(i.get("lines") or [])}
        for i in items
    ]}


def _get_invoice(user, invoice_id):
    if not re.fullmatch(r"[0-9a-f-]{10,40}", invoice_id or ""):
        raise ApiError(400, "Bad invoice id")
    item = db.store().get(db.user_pk(user["id"]), f"INV#{invoice_id}")
    if not item:
        raise ApiError(404, "Накладная не найдена")
    return item


def get_invoice(user, params, body):
    item = _get_invoice(user, params.get("id"))
    item.pop("PK", None)
    item.pop("SK", None)
    item["file_url"] = aws.client("s3").generate_presigned_url(
        "get_object", Params={"Bucket": config.UPLOAD_BUCKET, "Key": item["file_key"]}, ExpiresIn=600,
    )
    return item


def _num(value, field, required=True):
    if value in (None, ""):
        if required:
            raise ApiError(400, f"Поле {field} обязательно")
        return None
    try:
        return float(str(value).replace(" ", "").replace(",", "."))
    except ValueError:
        raise ApiError(400, f"Поле {field} должно быть числом")


def review_invoice(user, params, body):
    """The owner corrected the flagged fields; send the invoice back through validation as confirmed."""
    item = _get_invoice(user, params.get("id"))
    if item["status"] not in REVIEWABLE:
        raise ApiError(409, f"Накладную в статусе {item['status']} нельзя изменить")
    lines = body.get("lines")
    if not isinstance(lines, list) or not lines or len(lines) > 200:
        raise ApiError(400, "Нужен список строк")
    extraction = {
        "supplier_name": str(body.get("supplier_name") or "")[:200],
        "supplier_bin": str(body.get("supplier_bin") or "")[:20],
        "invoice_number": str(body.get("invoice_number") or "")[:50],
        "invoice_date": str(body.get("invoice_date") or "")[:10],
        "currency": "KZT",
        "total": _num(body.get("total"), "total"),
        "lines": [{
            "name": str(l.get("name") or "")[:200],
            "canonical_name": str(l.get("canonical_name") or l.get("name") or "")[:200],
            "quantity": _num(l.get("quantity"), "quantity"),
            "unit": str(l.get("unit") or "")[:20],
            "price": _num(l.get("price"), "price"),
            "total": _num(l.get("total"), "total"),
        } for l in lines],
    }
    item["status"] = "confirming"
    item["updated_at"] = now_iso()
    db.store().put(item)
    aws.client("sqs").send_message(
        QueueUrl=config.VALIDATE_QUEUE_URL,
        MessageBody=json.dumps({"user_id": user["id"], "invoice_id": item["invoice_id"],
                                "extraction": extraction, "confirmed": True}),
    )
    return {"invoice_id": item["invoice_id"], "status": "confirming"}


# ---------- products, alerts ----------

def list_products(user, params, body):
    items = db.store().query_prefix(db.user_pk(user["id"]), "PROD#")
    return {"products": [
        {k: i.get(k) for k in ("product_key", "name", "unit", "last_price", "last_date", "suppliers")}
        for i in items
    ]}


def get_product(user, params, body):
    key = params.get("key") or ""
    if not key or "#" in key or len(key) > 100:
        raise ApiError(400, "Bad product key")
    pk = db.user_pk(user["id"])
    product = db.store().get(pk, f"PROD#{key}")
    if not product:
        raise ApiError(404, "Товар не найден")
    history = db.store().query_prefix(pk, f"PRICE#{key}#")
    return {
        "product": {k: product.get(k) for k in ("product_key", "name", "unit", "last_price", "suppliers")},
        "history": [{k: h.get(k) for k in ("date", "price", "quantity", "supplier", "supplier_key", "invoice_id")}
                    for h in history],
    }


def list_alerts(user, params, body):
    items = db.store().query_prefix(db.user_pk(user["id"]), "ALERT#", newest_first=True, limit=50)
    fields = ("product", "product_key", "supplier", "old_price", "new_price", "change_pct", "quantity",
              "cheaper_supplier", "cheaper_price", "cheaper_pct", "invoice_id", "invoice_date", "created_at")
    return {"alerts": [{f: i.get(f) for f in fields} for i in items]}


# ---------- settings ----------

def _settings(user):
    s = db.store().get(db.user_pk(user["id"]), "SETTINGS") or {}
    return {
        "threshold_pct": s.get("threshold_pct", config.DEFAULT_THRESHOLD_PCT),
        "email": s.get("email"),
        "subscription_arn": s.get("subscription_arn"),
        "business_type": s.get("business_type"),
        "business_name": s.get("business_name"),
    }


def _pending(sub_arn):
    if not sub_arn:
        return False
    try:
        attrs = aws.client("sns").get_subscription_attributes(SubscriptionArn=sub_arn)["Attributes"]
        return attrs.get("PendingConfirmation") == "true"
    except Exception:
        log.exception("could not read subscription %s", sub_arn)
        return True


def get_settings(user, params, body):
    s = _settings(user)
    return {"threshold_pct": s["threshold_pct"], "email": s["email"], "account_email": user.get("email"),
            "email_pending": bool(s["email"]) and _pending(s["subscription_arn"]),
            "business_type": s["business_type"], "business_name": s["business_name"],
            "is_admin": bool(user.get("is_admin"))}


def put_settings(user, params, body):
    current = _settings(user)
    threshold = _num(body.get("threshold_pct", current["threshold_pct"]), "threshold_pct")
    if not 0.5 <= threshold <= 100:
        raise ApiError(400, "Порог должен быть от 0.5 до 100 %")
    # A partial update (the onboarding step sends only the business profile) keeps the other fields.
    email = (body["email"] or "").strip().lower() or None if "email" in body else current.get("email")
    if email and not EMAIL_RE.match(email):
        raise ApiError(400, "Некорректный email")
    business_type = body.get("business_type", current.get("business_type")) or None
    if business_type and business_type not in BUSINESS_TYPES:
        raise ApiError(400, "Неизвестный тип бизнеса")
    business_name = str(body.get("business_name", current.get("business_name")) or "").strip()[:80] or None

    sub_arn = current.get("subscription_arn")
    if email != current.get("email"):
        sns = aws.client("sns")
        if sub_arn and str(sub_arn).startswith("arn:"):
            try:
                sns.unsubscribe(SubscriptionArn=sub_arn)
            except Exception:
                log.exception("unsubscribe failed")
        sub_arn = None
        if email:
            sub_arn = sns.subscribe(
                TopicArn=config.ALERTS_TOPIC_ARN,
                Protocol="email",
                Endpoint=email,
                Attributes={"FilterPolicy": json.dumps({"user_id": [user["id"]]})},
                ReturnSubscriptionArn=True,
            )["SubscriptionArn"]

    db.store().put({
        "PK": db.user_pk(user["id"]),
        "SK": "SETTINGS",
        "threshold_pct": threshold,
        "email": email,
        "subscription_arn": sub_arn,
        "business_type": business_type,
        "business_name": business_name,
        "updated_at": now_iso(),
    })
    return {"threshold_pct": threshold, "email": email,
            "business_type": business_type, "business_name": business_name,
            "message": "Подтвердите подписку по ссылке в письме от AWS" if email and email != current.get("email") else "Сохранено"}


# ---------- admin ----------

def admin_overview(user, params, body):
    """Numbers across all accounts. No invoice contents, no emails: counts and the latest activity only."""
    if not user.get("is_admin"):
        raise ApiError(403, "Доступно только администратору")
    store = db.store()
    invoices = store.scan_prefix("INV#")
    settings = store.scan_sk("SETTINGS")
    alerts = store.scan_prefix("ALERT#")
    statuses, types = {}, {}
    for inv in invoices:
        statuses[inv.get("status") or "unknown"] = statuses.get(inv.get("status") or "unknown", 0) + 1
    for s in settings:
        types[s.get("business_type") or "none"] = types.get(s.get("business_type") or "none", 0) + 1
    accounts = {i["PK"] for i in invoices} | {s["PK"] for s in settings}
    week_ago = datetime.now(timezone.utc).timestamp() - 7 * 86400
    def recent(item):
        try:
            return datetime.strptime(item.get("created_at", ""), "%Y-%m-%dT%H:%M:%SZ") \
                .replace(tzinfo=timezone.utc).timestamp() >= week_ago
        except ValueError:
            return False
    latest = sorted(invoices, key=lambda i: i.get("created_at") or "", reverse=True)[:10]
    return {
        "accounts": len(accounts),
        "invoices": len(invoices),
        "invoices_week": sum(1 for i in invoices if recent(i)),
        "alerts": len(alerts),
        "by_status": statuses,
        "by_business_type": types,
        "latest": [{"created_at": i.get("created_at"), "status": i.get("status"),
                    "supplier_name": i.get("supplier_name"), "total": i.get("total"),
                    "account": i["PK"][-6:]} for i in latest],
    }


ROUTES = {
    "POST /uploads": create_upload,
    "GET /invoices": list_invoices,
    "GET /invoices/{id}": get_invoice,
    "PUT /invoices/{id}": review_invoice,
    "GET /products": list_products,
    "GET /products/{key}": get_product,
    "GET /alerts": list_alerts,
    "GET /settings": get_settings,
    "PUT /settings": put_settings,
    "GET /admin/overview": admin_overview,
}
