import json
from datetime import date, timedelta

import api
from supplyradar import db, ledger

SHOP = "shop-user-1"
ACCOUNTANT = "acc-user-2"


def call(user, route, body=None, query=None, verified=True, **path):
    event = {
        "routeKey": route,
        "pathParameters": path or None,
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None else None,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": user, "email": f"{user}@example.com",
                                                                "email_verified": "true" if verified else "false"}}}},
    }
    resp = api.handler(event, None)
    return resp["statusCode"], json.loads(resp["body"])


def setup_shop(store, milk_qty=50):
    call(SHOP, "PUT /settings", {"business_type": "cafe", "business_name": "Кофейня на Абая"})
    pk = db.user_pk(SHOP)
    today = date.today().isoformat()
    store.put({"PK": pk, "SK": "PROD#milk", "product_key": "milk", "name": "молоко 1 л", "unit": "шт", "last_price": 400,
               "suppliers": {"a": {"name": "ТОО Молочный двор", "price": 400, "date": today}}})
    store.put({"PK": pk, "SK": f"PRICE#milk#{today}#inv1#0", "product_key": "milk", "date": today, "price": 400,
               "quantity": milk_qty, "unit": "шт", "invoice_id": "inv1"})
    store.put({"PK": pk, "SK": "INV#inv1", "invoice_id": "inv1", "status": "checked", "invoice_number": "77",
               "invoice_date": today, "supplier_name": "ТОО Молочный двор", "total": 400 * milk_qty})
    store.put({"PK": pk, "SK": "RECIPE#latte", "recipe_id": "latte", "name": "Латте", "portions": 1, "menu_price": 1500,
               "ingredients": [{"product_key": "milk", "qty": 0.25}]})


def sell(lines, payment="cash", discount=None):
    return call(SHOP, "POST /sales", {"lines": lines, "payment": payment, "discount": discount})


def test_sale_makes_a_numbered_receipt_with_seller_and_cost(store):
    setup_shop(store)
    call(SHOP, "PUT /taxes", {"bin": "123456789012", "address": "Абая 10"})
    status, r = sell([{"kind": "recipe", "key": "latte", "qty": 2, "price": 1500},
                      {"kind": "product", "key": "milk", "qty": 1, "price": 650}], discount=150)
    assert status == 200, r
    assert r["number"] == 1 and r["subtotal"] == 3650 and r["total"] == 3500
    assert r["seller"] == {"name": "Кофейня на Абая", "bin": "123456789012", "address": "Абая 10"}
    assert r["lines"][0]["unit_cost"] == 100  # 0.25 l of milk at 400
    assert sell([{"kind": "free", "name": "Пакет", "qty": 1, "price": 50}], "card")[1]["number"] == 2
    day = call(SHOP, "GET /sales")[1]
    assert day["count"] == 2 and day["total"] == 3550 and day["by_payment"]["card"] == 50
    assert {i["name"] for i in day["sellables"]} == {"Латте", "молоко 1 л"}


def test_sale_validation(store):
    setup_shop(store)
    assert sell([{"kind": "recipe", "key": "nope", "qty": 1, "price": 1}])[0] == 400
    assert sell([{"kind": "recipe", "key": "latte", "qty": 0, "price": 1}])[0] == 400
    assert sell([{"kind": "recipe", "key": "latte", "qty": 1, "price": 1}], payment="crypto")[0] == 400
    assert sell([{"kind": "recipe", "key": "latte", "qty": 1, "price": 100}], discount=200)[0] == 400


def test_refund_needs_a_reason_and_happens_once(store):
    setup_shop(store)
    sale = sell([{"kind": "recipe", "key": "latte", "qty": 1, "price": 1500}])[1]
    assert call(SHOP, "PUT /sales/{id}", {}, id=sale["sale_id"])[0] == 400
    status, r = call(SHOP, "PUT /sales/{id}", {"reason": "Ошибка кассира"}, id=sale["sale_id"])
    assert status == 200 and r["status"] == "refunded"
    assert call(SHOP, "PUT /sales/{id}", {"reason": "ещё раз"}, id=sale["sale_id"])[0] == 409
    assert call(SHOP, "GET /sales")[1]["total"] == 0


def test_stock_moves_with_invoices_and_sales_and_drafts_an_order(store):
    setup_shop(store, milk_qty=10)
    sell([{"kind": "recipe", "key": "latte", "qty": 8, "price": 1500}, {"kind": "product", "key": "milk", "qty": 4, "price": 650}])
    row = call(SHOP, "GET /stock")[1]["stock"][0]
    assert row["on_hand"] == 4  # 10 received - 2 in lattes - 4 sold
    status, row = call(SHOP, "PUT /stock/{key}", {"min_qty": 5}, key="milk")
    assert status == 200 and row["low"]
    data = call(SHOP, "GET /stock")[1]
    assert data["low"] == 1
    order = data["orders"][0]
    assert order["supplier"] == "ТОО Молочный двор" and order["items"][0]["qty"] == 6
    assert "Просим привезти" in order["text"] and "Кофейня на Абая" in order["text"]
    row = call(SHOP, "PUT /stock/{key}", {"count": 3}, key="milk")[1]  # stocktaking
    assert row["on_hand"] == 3 and row["adjust"] == -1
    assert call(SHOP, "PUT /stock/{key}", {"min_qty": 1}, key="ghost")[0] == 404


def test_expenses_and_monthly_repeat(store):
    setup_shop(store)
    month = date.today().isoformat()[:7]
    assert call(SHOP, "POST /expenses", {"category": "salary", "amount": 0})[0] == 400
    assert call(SHOP, "POST /expenses", {"category": "salary", "amount": 150000, "note": "Бариста"})[0] == 200
    two_months_ago = (date.today().replace(day=1) - timedelta(days=40)).replace(day=5).isoformat()
    assert call(SHOP, "POST /expenses", {"category": "rent", "amount": 200000, "date": two_months_ago, "monthly": True})[0] == 200
    data = call(SHOP, "GET /expenses", query={"month": month})[1]
    assert data["total"] == 350000 and data["by_category"] == {"salary": 150000, "rent": 200000}
    rent = next(e for e in data["expenses"] if e["category"] == "rent")
    assert call(SHOP, "DELETE /expenses/{id}", id=rent["expense_id"])[0] == 200  # skip this month only
    assert call(SHOP, "GET /expenses", query={"month": month})[1]["total"] == 150000
    prev = two_months_ago[:7]
    assert call(SHOP, "GET /expenses", query={"month": prev})[1]["total"] == 200000


def test_report_counts_income_purchases_expenses_and_drafts_tax(store):
    setup_shop(store)
    sell([{"kind": "recipe", "key": "latte", "qty": 10, "price": 1500}])
    refunded = sell([{"kind": "recipe", "key": "latte", "qty": 1, "price": 1500}])[1]
    call(SHOP, "PUT /sales/{id}", {"reason": "Остыл"}, id=refunded["sale_id"])
    call(SHOP, "POST /expenses", {"category": "rent", "amount": 5000})
    month = date.today().isoformat()[:7]
    r = call(SHOP, "GET /reports", query={"period": month})[1]
    assert r["income"] == 15000 and r["refunds"] == 1500 and r["purchases"] == 20000 and r["expenses"] == 5000
    assert r["profit"] == -10000
    assert r["tax"]["amount"] is None and any("Ставка" in c for c in r["tax"]["checks"])
    latte = r["by_product"][0]
    assert latte["revenue"] == 15000 and latte["cost"] == 1000 and latte["margin_pct"] == 93.3
    kinds = {row["kind"] for row in r["journal"]}
    assert kinds == {"sale", "refund", "purchase", "expense"}
    call(SHOP, "PUT /taxes", {"regime": "Упрощённая декларация", "rate_pct": 3})
    q = (int(month[5:]) - 1) // 3 + 1
    tax = call(SHOP, "GET /reports", query={"period": f"{month[:4]}-Q{q}"})[1]["tax"]
    assert tax["rate_pct"] == 3 and tax["amount"] == 450 and tax["regime"] == "Упрощённая декларация"
    assert call(SHOP, "GET /reports", query={"period": "2026-13"})[0] == 400
    assert call(SHOP, "PUT /taxes", {"rate_pct": 90})[0] == 400
    assert call(SHOP, "PUT /taxes", {"bin": "123"})[0] == 400


def test_period_parsing():
    assert ledger.parse_period("2026-02")[1:] == ("2026-02-01", "2026-02-28")
    assert ledger.parse_period("2026-Q4")[1:] == ("2026-10-01", "2026-12-31")
    assert ledger.parse_period("2026-H1")[1:] == ("2026-01-01", "2026-06-30")
    assert ledger.parse_period("2026")[1:] == ("2026-01-01", "2026-12-31")


def test_tax_calendar_rolls_repeating_deadlines_forward(store):
    setup_shop(store)
    past = (date.today() - timedelta(days=40)).isoformat()
    soon = (date.today() + timedelta(days=3)).isoformat()
    assert call(SHOP, "POST /taxes/deadlines", {"title": "Соцплатежи", "due": past, "repeat": "monthly"})[0] == 200
    assert call(SHOP, "POST /taxes/deadlines", {"title": "Декларация", "due": soon})[0] == 200
    assert call(SHOP, "POST /taxes/deadlines", {"title": "x", "due": "завтра"})[0] == 400
    rows = call(SHOP, "GET /taxes")[1]["deadlines"]
    monthly = next(r for r in rows if r["title"] == "Соцплатежи")
    assert monthly["next_due"] >= date.today().isoformat() and 0 <= monthly["days_left"] <= 31
    assert any(d["title"] == "Декларация" for d in call(SHOP, "GET /settings")[1]["deadlines_soon"])
    did = next(r for r in rows if r["title"] == "Декларация")["deadline_id"]
    assert call(SHOP, "DELETE /taxes/deadlines/{id}", id=did)[0] == 200
    assert len(call(SHOP, "GET /taxes")[1]["deadlines"]) == 1


def test_accountant_reads_only_what_was_shared(store):
    setup_shop(store)
    sell([{"kind": "recipe", "key": "latte", "qty": 2, "price": 1500}])
    acc_email = f"{ACCOUNTANT}@example.com"
    assert call(ACCOUNTANT, "GET /shared/{owner}/reports", owner=SHOP)[0] == 403
    assert call(SHOP, "POST /access", {"email": "not-an-email"})[0] == 400
    assert call(SHOP, "POST /access", {"email": acc_email.upper()})[0] == 200
    assert call(SHOP, "GET /access")[1]["accountants"][0]["email"] == acc_email
    owners = call(ACCOUNTANT, "GET /shared")[1]["owners"]
    assert owners == [{"owner_id": SHOP, "name": "Кофейня на Абая", "since": owners[0]["since"]}]
    status, r = call(ACCOUNTANT, "GET /shared/{owner}/reports", owner=SHOP)
    assert status == 200 and r["read_only"] and r["income"] == 3000
    assert call(ACCOUNTANT, "GET /shared/{owner}/reports", verified=False, owner=SHOP)[0] == 403
    assert call(ACCOUNTANT, "GET /sales")[1]["count"] == 0  # its own (empty) books, not the owner's
    assert call(SHOP, "DELETE /access/{email}", email=acc_email)[0] == 200
    assert call(ACCOUNTANT, "GET /shared/{owner}/reports", owner=SHOP)[0] == 403
    assert call(ACCOUNTANT, "GET /shared")[1]["owners"] == []


def test_suppliers_have_no_books(store):
    call(SHOP, "PUT /settings", {"business_type": "supplier", "business_name": "ТОО"})
    assert call(SHOP, "GET /sales")[0] == 403
    assert call(SHOP, "GET /reports")[0] == 403


def test_demo_data_includes_sales_and_is_removed(store):
    call(SHOP, "PUT /settings", {"business_type": "cafe", "business_name": "Кофейня"})
    assert call(SHOP, "POST /demo")[0] == 200
    pk = db.user_pk(SHOP)
    assert store.query_prefix(pk, "SALE#") and store.query_prefix(pk, "EXP#")
    stock = call(SHOP, "GET /stock")[1]
    assert stock["low"] >= 1
    assert call(SHOP, "DELETE /demo")[0] == 200
    assert not store.query_prefix(pk, "SALE#") and not store.query_prefix(pk, "STOCK#")
