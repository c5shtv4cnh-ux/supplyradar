import io
import json
import urllib.error
from datetime import date, timedelta

import pytest

import api
import digest
import extract
import notify
import validate
from supplyradar import gemini

USER = "user-123"
LAST_WEEK = (date.today() - timedelta(days=7)).isoformat()
LAST_MONTH = (date.today() - timedelta(days=30)).isoformat()
BIN_A = "990140000017"


def api_event(route, body=None, **path):
    return {
        "routeKey": route,
        "pathParameters": path or None,
        "body": json.dumps(body) if body is not None else None,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": USER, "email": "o@example.com"}}}},
    }


def call(route, body=None, **path):
    resp = api.handler(api_event(route, body, **path), None)
    return resp["statusCode"], json.loads(resp["body"])


def extraction(price_cream=1680, number="2417", date=LAST_WEEK, bin_=BIN_A, supplier="ТОО Молочный двор"):
    return {
        "supplier_name": supplier, "supplier_bin": bin_, "invoice_number": number,
        "invoice_date": date, "currency": "KZT", "total": 840 + price_cream,
        "lines": [
            {"name": "Молоко 3,2% 1 л", "canonical_name": "молоко 3.2% 1 л",
             "quantity": 2, "unit": "шт", "price": 420, "total": 840},
            {"name": "Сливки 33% 0,5 л", "canonical_name": "сливки 33% 0.5 л",
             "quantity": 1, "unit": "шт", "price": price_cream, "total": price_cream},
        ],
    }


def upload(clients, store, monkeypatch):
    status, body = call("POST /uploads", {"content_type": "image/jpeg", "file_name": "a.jpg"})
    assert status == 200
    return body


def run_validate(invoice_id, ext, confirmed=False):
    msg = {"user_id": USER, "invoice_id": invoice_id, "extraction": ext, "confirmed": confirmed}
    result = validate.handler({"Records": [{"messageId": "m1", "body": json.dumps(msg)}]}, None)
    assert result == {"batchItemFailures": []}


def test_upload_creates_record_and_presigned_post(store, clients, monkeypatch):
    body = upload(clients, store, monkeypatch)
    item = store.get(f"USER#{USER}", f"INV#{body['invoice_id']}")
    assert item["status"] == "uploading"
    assert item["file_key"] == f"uploads/{USER}/{body['invoice_id']}.jpg"
    assert body["upload"]["fields"]["key"] == item["file_key"]
    assert "uploads-bucket" in body["upload"]["url"]


def test_upload_rejects_other_types(store, clients):
    status, body = call("POST /uploads", {"content_type": "text/html"})
    assert status == 400


def test_unknown_route_and_bad_json(store, clients):
    assert call("DELETE /everything")[0] == 404
    event = api_event("PUT /settings")
    event["body"] = "{not json"
    assert api.handler(event, None)["statusCode"] == 400


def test_full_flow_alert_after_price_increase(store, clients, monkeypatch):
    first = upload(clients, store, monkeypatch)["invoice_id"]
    run_validate(first, extraction(price_cream=1500, number="2400", date=LAST_MONTH))
    assert store.get(f"USER#{USER}", f"INV#{first}")["status"] == "checked"
    assert store.by_prefix("ALERT#") == []

    second = upload(clients, store, monkeypatch)["invoice_id"]
    run_validate(second, extraction(price_cream=1680))
    alerts = store.by_prefix("ALERT#")
    assert len(alerts) == 1
    assert alerts[0]["product"] == "сливки 33% 0.5 л"
    assert alerts[0]["change_pct"] == 12.0

    # a duplicate SQS delivery changes nothing
    run_validate(second, extraction(price_cream=1680))
    assert len(store.by_prefix("ALERT#")) == 1

    status, products = call("GET /products")
    assert {p["product_key"] for p in products["products"]} == {"молоко-3.2pct-1-л", "сливки-33pct-0.5-л"}
    status, hist = call("GET /products/{key}", key="%D1%81%D0%BB%D0%B8%D0%B2%D0%BA%D0%B8-33pct-0.5-%D0%BB")
    assert status == 200 and [h["price"] for h in hist["history"]] == [1500, 1680]
    assert call("GET /alerts")[1]["alerts"][0]["new_price"] == 1680


def test_bad_invoice_goes_to_review_then_confirm(store, clients, monkeypatch):
    inv_id = upload(clients, store, monkeypatch)["invoice_id"]
    bad = extraction()
    bad["lines"][1]["total"] = 1860
    run_validate(inv_id, bad)
    item = store.get(f"USER#{USER}", f"INV#{inv_id}")
    assert item["status"] == "needs_review"
    assert item["issues"][0]["field"] == "lines.1.total"
    assert store.by_prefix("PRICE#") == []

    fixed = extraction()
    status, body = call("PUT /invoices/{id}", fixed, id=inv_id)
    assert status == 200 and body["status"] == "confirming"
    sent = json.loads(clients["sqs"].calls[-1][1]["MessageBody"])
    assert sent["confirmed"] is True
    run_validate(inv_id, sent["extraction"], confirmed=True)
    assert store.get(f"USER#{USER}", f"INV#{inv_id}")["status"] == "confirmed"
    assert len(store.by_prefix("PRICE#")) == 2


def test_duplicate_invoice_number_is_flagged(store, clients, monkeypatch):
    a = upload(clients, store, monkeypatch)["invoice_id"]
    run_validate(a, extraction())
    b = upload(clients, store, monkeypatch)["invoice_id"]
    run_validate(b, extraction())
    item = store.get(f"USER#{USER}", f"INV#{b}")
    assert item["status"] == "needs_review"
    assert item["duplicate_of"] == a


def test_settings_subscribe_email_with_filter_policy(store, clients):
    status, body = call("PUT /settings", {"threshold_pct": 8, "email": "Owner@Example.com"})
    assert status == 200 and body["email"] == "owner@example.com"
    name, kwargs = clients["sns"].calls[-1]
    assert name == "subscribe"
    assert json.loads(kwargs["Attributes"]["FilterPolicy"]) == {"user_id": [USER]}
    assert call("PUT /settings", {"threshold_pct": 500})[0] == 400
    assert call("GET /settings")[1]["threshold_pct"] == 8


def test_threshold_from_settings_is_used(store, clients, monkeypatch):
    call("PUT /settings", {"threshold_pct": 20})
    a = upload(clients, store, monkeypatch)["invoice_id"]
    run_validate(a, extraction(price_cream=1500, number="1", date=LAST_MONTH))
    b = upload(clients, store, monkeypatch)["invoice_id"]
    run_validate(b, extraction(price_cream=1680, number="2"))
    assert store.by_prefix("ALERT#") == []


def test_notify_formats_and_publishes(clients):
    alert = {"SK": {"S": "ALERT#2026-10-12T10:00:00Z#inv#k"}, "user_id": {"S": USER},
             "product": {"S": "сливки 33% 0.5 л"}, "product_key": {"S": "k"},
             "supplier": {"S": "ТОО Молочный двор"}, "old_price": {"N": "1500"},
             "new_price": {"N": "1680"}, "change_pct": {"N": "12"}, "quantity": {"N": "3"},
             "cheaper_supplier": {"S": "ТОО Свежая ферма"}, "cheaper_price": {"N": "1545"},
             "cheaper_pct": {"N": "8"}, "invoice_date": {"S": "2026-10-12"}}
    event = {"Records": [{"dynamodb": {"NewImage": alert, "SequenceNumber": "1"}}]}
    assert notify.handler(event, None) == {"batchItemFailures": []}
    name, kwargs = clients["sns"].calls[-1]
    assert kwargs["Subject"] == "SupplyRadar: сливки 33% 0.5 л +12%"
    assert "1 500 ₸" in kwargs["Message"] and "540 ₸" in kwargs["Message"]
    assert "Свежая ферма" in kwargs["Message"]
    assert kwargs["MessageAttributes"]["user_id"]["StringValue"] == USER


def test_digest_falls_back_to_template(store, clients, monkeypatch):
    store.put({"PK": f"USER#{USER}", "SK": "SETTINGS", "email": "o@example.com"})
    store.put({"PK": f"USER#{USER}", "SK": "ALERT#2999-01-01T00:00:00Z#i#k", "product": "сливки",
               "supplier": "A", "old_price": 1500, "new_price": 1680, "change_pct": 12, "quantity": 2})

    def boom(*a, **k):
        raise gemini.GeminiError("down")
    monkeypatch.setattr(gemini, "write_text", boom)
    assert digest.handler({}, None) == {"sent": 1}
    message = clients["sns"].calls[-1][1]["Message"]
    assert "Переплата: 360 ₸" in message


def test_extract_parse_key():
    assert extract.parse_key("uploads/u1/20261019-ab.jpg") == ("u1", "20261019-ab", "jpg")
    with pytest.raises(ValueError):
        extract.parse_key("other/u1/x.jpg")


def test_gemini_response_parsing_and_errors(monkeypatch):
    ok = {"candidates": [{"content": {"parts": [{"text": '{"lines": []}'}]}}]}
    assert gemini.response_text(ok) == '{"lines": []}'
    with pytest.raises(gemini.GeminiError):
        gemini.response_text({"promptFeedback": {"blockReason": "SAFETY"}})
    with pytest.raises(gemini.GeminiError):
        gemini.response_text({"candidates": [{"finishReason": "MAX_TOKENS", "content": {}}]})

    monkeypatch.setattr(gemini, "_api_key", "k")

    def rate_limited(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many", {}, io.BytesIO(b"quota"))
    monkeypatch.setattr(gemini.urllib.request, "urlopen", rate_limited)
    with pytest.raises(gemini.GeminiRateLimited):
        gemini.extract_invoice(b"img", "image/jpeg")
