import json
from datetime import date, timedelta

import api
from supplyradar import db, market

SHOP = "shop-user-1"
OTHER = "supplier-9"


def call(user, route, body=None, **path):
    event = {
        "routeKey": route,
        "pathParameters": path or None,
        "body": json.dumps(body) if body is not None else None,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": user, "email": f"{user}@example.com",
                                                                "email_verified": "true"}}}},
    }
    resp = api.handler(event, None)
    return resp["statusCode"], json.loads(resp["body"])


def setup(store, plan=None):
    call(SHOP, "PUT /settings", {"business_type": "cafe", "business_name": "Кофейня на Абая"})
    if plan:
        assert call(SHOP, "POST /subscription", {"plan": plan, "demo": True})[0] == 200


def put_price(store, key, name, supplier, price, qty, days_ago, location=None, inv="inv1", unit="шт"):
    pk = db.user_pk(SHOP)
    when = (date.today() - timedelta(days=days_ago)).isoformat()
    product = store.get(pk, f"PROD#{key}") or {"PK": pk, "SK": f"PROD#{key}", "product_key": key, "name": name,
                                                 "unit": unit, "suppliers": {}}
    product["suppliers"][supplier] = {"name": f"Поставщик {supplier}", "price": price, "date": when, "invoice_id": inv}
    product["last_price"], product["last_date"] = price, when
    store.put(product)
    store.put({"PK": pk, "SK": f"PRICE#{key}#{when}#{inv}#0", "product_key": key, "date": when, "price": price,
               "quantity": qty, "unit": unit, "supplier": f"Поставщик {supplier}", "supplier_key": supplier,
               "invoice_id": inv, "location_id": location})
    store.put({"PK": pk, "SK": f"INV#{inv}", "invoice_id": inv, "status": "checked", "invoice_number": "55",
               "invoice_date": when, "supplier_name": f"Поставщик {supplier}", "total": price * qty,
               "location_id": location, "lines": [{"product_key": key, "quantity": qty}]})


# ---------- savings: trend, months, payback ----------

def test_savings_has_trend_months_and_payback(store, clients):
    setup(store)
    put_price(store, "молоко", "молоко", "b", 400, 1, 2, inv="i0")           # the best price now
    put_price(store, "молоко", "молоко", "a", 500, 100, 5, inv="i1")         # this month: 100 pcs, +100 each
    put_price(store, "молоко", "молоко", "a", 450, 40, 40, inv="i2")         # last month: 40 pcs, +50 each
    status, body = call(SHOP, "GET /savings")
    assert status == 200 and body["overpay"] == 10_000 and body["previous_overpay"] == 2_000
    assert len(body["by_month"]) == 6 and body["by_month"][-1]["month"] == date.today().isoformat()[:7]
    assert body["payback"]["pro_price"] == 4990 and body["payback"]["recoverable"] == 3333
    assert body["payback"]["pays_back"] is False  # a third of the overpay (3 333) is below the Pro price (4 990)


def test_payback_flag_when_the_overpay_is_large(store, clients):
    setup(store)
    put_price(store, "молоко", "молоко", "b", 400, 1, 2, inv="i0")
    put_price(store, "молоко", "молоко", "a", 700, 200, 5, inv="i1")  # 60 000 overpaid
    body = call(SHOP, "GET /savings")[1]
    assert body["overpay"] == 60_000 and body["payback"]["pays_back"] is True


# ---------- locations ----------

def test_locations_are_a_network_plan_feature(store, clients):
    setup(store, "pro")
    assert call(SHOP, "POST /locations", {"name": "Центр"})[0] == 402
    call(SHOP, "POST /subscription", {"plan": "network", "demo": True})
    status, loc = call(SHOP, "POST /locations", {"name": "Центр", "address": "Абая 1"})
    assert status == 200 and loc["name"] == "Центр"
    assert call(SHOP, "POST /locations", {"name": ""})[0] == 400
    assert call(SHOP, "PUT /locations/{id}", {"name": "Центр 2"}, id=loc["location_id"])[1]["name"] == "Центр 2"
    assert call(SHOP, "PUT /locations/{id}", {"name": "x"}, id="0123456789")[0] == 404


def test_location_panel_splits_spend_and_overpay_by_point(store, clients):
    setup(store, "network")
    loc = call(SHOP, "POST /locations", {"name": "Центр"})[1]["location_id"]
    put_price(store, "молоко", "молоко", "b", 400, 1, 2, inv="i0")
    put_price(store, "молоко", "молоко", "a", 500, 10, 3, location=None, inv="i1")   # main point: +1 000
    put_price(store, "молоко", "молоко", "a", 500, 30, 4, location=loc, inv="i2")    # Центр: +3 000
    status, body = call(SHOP, "GET /locations")
    assert status == 200 and body["limit"] == 10
    by_id = {r["location_id"]: r for r in body["locations"]}
    assert by_id["main"]["overpay"] == 1_000 and by_id[loc]["overpay"] == 3_000
    assert by_id[loc]["invoices"] == 1 and by_id["main"]["name"] == "Кофейня на Абая"
    # deleting a point moves its deliveries to the main one
    call(SHOP, "DELETE /locations/{id}", id=loc)
    assert call(SHOP, "GET /locations")[1]["locations"][0]["overpay"] == 4_000


def test_upload_can_be_tagged_with_a_point(store, clients):
    setup(store, "network")
    loc = call(SHOP, "POST /locations", {"name": "Центр"})[1]["location_id"]
    assert call(SHOP, "POST /uploads", {"content_type": "image/jpeg", "location_id": "nope-nope"})[0] == 400
    status, up = call(SHOP, "POST /uploads", {"content_type": "image/jpeg", "location_id": loc})
    assert status == 200
    assert store.get(db.user_pk(SHOP), f"INV#{up['invoice_id']}")["location_id"] == loc
    assert call(SHOP, "POST /uploads", {"content_type": "image/jpeg", "location_id": "main"})[0] == 200


# ---------- contracts ----------

def test_contract_flags_prices_above_the_agreed_one(store, clients):
    setup(store, "pro")
    put_price(store, "молоко", "молоко", "a", 450, 20, 3, inv="i1")
    assert call(SHOP, "PUT /contracts", {"product_key": "молоко", "supplier_key": "zzz", "price": 400})[0] == 404
    assert call(SHOP, "PUT /contracts", {"product_key": "молоко", "supplier_key": "a", "price": 0})[0] == 400
    status, c = call(SHOP, "PUT /contracts", {"product_key": "молоко", "supplier_key": "a", "price": 400, "tolerance_pct": 5})
    assert status == 200 and c["status"] == "over" and c["deviation_pct"] == 12.5
    body = call(SHOP, "GET /contracts")[1]
    assert body["violations"] == 1 and body["candidates"] == [] and body["contracts"][0]["actual_price"] == 450
    # inside the tolerance it is fine
    call(SHOP, "PUT /contracts", {"product_key": "молоко", "supplier_key": "a", "price": 440, "tolerance_pct": 5})
    assert call(SHOP, "GET /contracts")[1]["contracts"][0]["status"] == "ok"
    assert call(SHOP, "DELETE /contracts/{id}", id=c["contract_id"])[0] == 200
    assert len(call(SHOP, "GET /contracts")[1]["candidates"]) == 1


def test_free_plan_watches_three_contracts(store, clients):
    setup(store)
    for i in range(4):
        put_price(store, f"товар{i}", f"товар {i}", "a", 100, 1, 3, inv=f"i{i}")
    for i in range(3):
        assert call(SHOP, "PUT /contracts", {"product_key": f"товар{i}", "supplier_key": "a", "price": 90})[0] == 200
    assert call(SHOP, "PUT /contracts", {"product_key": "товар3", "supplier_key": "a", "price": 90})[0] == 402
    # changing an existing one is not a new contract
    assert call(SHOP, "PUT /contracts", {"product_key": "товар0", "supplier_key": "a", "price": 95})[0] == 200


# ---------- claims ----------

def test_claim_from_an_alert_carries_the_numbers_and_can_be_resolved(store, clients):
    setup(store)
    put_price(store, "молоко", "молоко 3.2% 1 л", "a", 440, 60, 4, inv="i1")
    pk = db.user_pk(SHOP)
    store.put({"PK": pk, "SK": "ALERT#2026-11-01T00:00:00Z#i1#молоко", "product_key": "молоко", "product": "молоко 3.2% 1 л",
               "supplier": "Поставщик a", "old_price": 400, "new_price": 440, "change_pct": 10.0, "quantity": 60,
               "invoice_id": "i1", "invoice_date": date.today().isoformat(), "cheaper_pct": 8.0})
    assert call(SHOP, "POST /claims", {"kind": "alert", "invoice_id": "nope", "product_key": "молоко"})[0] == 404
    status, claim = call(SHOP, "POST /claims", {"kind": "alert", "invoice_id": "i1", "product_key": "молоко"})
    assert status == 200 and claim["amount"] == 2_400 and claim["status"] == "draft"
    for part in ("молоко 3.2% 1 л", "440 ₸", "400 ₸", "накладной № 55", "2 400 ₸", "дешевле примерно на 8%", "Кофейня на Абая"):
        assert part in claim["text"], part
    assert "55" in claim["subject"]
    cid = claim["claim_id"]
    assert call(SHOP, "PUT /claims/{id}", {"status": "sent"}, id=cid)[1]["status"] == "sent"
    assert call(SHOP, "PUT /claims/{id}", {"status": "magic"}, id=cid)[0] == 400
    done = call(SHOP, "PUT /claims/{id}", {"status": "resolved", "refund": 1800}, id=cid)[1]
    assert done["refund"] == 1800
    listing = call(SHOP, "GET /claims")[1]
    assert listing["refunded"] == 1800 and len(listing["claims"]) == 1
    assert call(SHOP, "GET /savings")[1]["refunded"] == 1800  # the dashboard shows what was won back


def test_claim_from_a_contract_needs_a_violation(store, clients):
    setup(store)
    put_price(store, "молоко", "молоко", "a", 450, 20, 3, inv="i1")
    cid = call(SHOP, "PUT /contracts", {"product_key": "молоко", "supplier_key": "a", "price": 400})[1]["contract_id"]
    status, claim = call(SHOP, "POST /claims", {"kind": "contract", "contract_id": cid})
    assert status == 200 and claim["amount"] == 1_000 and "По договору" in claim["text"] and "450 ₸" in claim["text"]
    call(SHOP, "PUT /contracts", {"product_key": "молоко", "supplier_key": "a", "price": 460})
    assert call(SHOP, "POST /claims", {"kind": "contract", "contract_id": cid})[0] == 409
    assert call(SHOP, "POST /claims", {"kind": "other"})[0] == 400


# ---------- demo data ----------

def test_demo_data_builds_a_history_with_an_alert_and_can_be_removed(store, clients):
    setup(store)
    status, body = call(SHOP, "POST /demo")
    assert status == 200 and body["invoices"] == 3
    assert call(SHOP, "POST /demo")[0] == 409
    invoices = call(SHOP, "GET /invoices")[1]["invoices"]
    assert len(invoices) == 3 and all(i["demo"] for i in invoices)
    assert call(SHOP, "GET /alerts")[1]["alerts"], "the price rise raises an alert"
    products = call(SHOP, "GET /products")[1]["products"]
    assert {p["product_key"] for p in products} == {"demo-milk", "demo-cream", "demo-flour"}
    detail = call(SHOP, "GET /invoices/{id}", id=invoices[0]["invoice_id"])
    assert detail[0] == 200 and detail[1]["file_url"] is None
    assert call(SHOP, "GET /savings")[1]["overpay"] > 0

    # a real invoice stays when the demo is cleared
    store.put({"PK": db.user_pk(SHOP), "SK": "INV#20261101000000-aaaaaaaa", "invoice_id": "20261101000000-aaaaaaaa", "status": "checked"})
    assert call(SHOP, "DELETE /demo")[1]["removed"] > 0
    left = call(SHOP, "GET /invoices")[1]["invoices"]
    assert [i["invoice_id"] for i in left] == ["20261101000000-aaaaaaaa"]
    assert call(SHOP, "GET /alerts")[1]["alerts"] == [] and call(SHOP, "GET /products")[1]["products"] == []


def test_new_routes_are_for_businesses_not_suppliers(store, clients):
    call(OTHER, "PUT /settings", {"business_type": "supplier", "business_name": "Поставщик"})
    for route in ("GET /locations", "GET /contracts", "GET /claims", "POST /demo"):
        assert call(OTHER, route)[0] == 403, route
