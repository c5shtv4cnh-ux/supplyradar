import json
from datetime import date, timedelta

import api
from supplyradar import db, gemini, market

SUPPLIER = "supplier-1"
SHOP = "shop-user-1"
TODAY = date.today().isoformat()


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


def setup_accounts(store):
    call(SUPPLIER, "PUT /settings", {"business_type": "supplier", "business_name": "ТОО Молочный двор",
                                     "contact": "+7 700 000 00 00"})
    call(SHOP, "PUT /settings", {"business_type": "cafe", "business_name": "Кофейня на Абая"})


def add_item(name="Молоко 3,2% 1 л", price=380, **extra):
    status, item = call(SUPPLIER, "POST /catalog", {"name": name, "unit": "шт", "price": price, **extra})
    assert status == 200, item
    return item


def put_product(store, key, name, prices, qty=10, days_ago=5):
    """prices: {supplier_key: price}. One purchase of `qty` at the first supplier's price."""
    pk = db.user_pk(SHOP)
    when = (date.today() - timedelta(days=days_ago)).isoformat()
    suppliers = {k: {"name": f"Поставщик {k}", "price": p, "date": when} for k, p in prices.items()}
    first_key, first_price = next(iter(prices.items()))
    store.put({"PK": pk, "SK": f"PROD#{key}", "product_key": key, "name": name, "unit": "шт",
               "suppliers": suppliers, "last_price": first_price, "last_date": when})
    store.put({"PK": pk, "SK": f"PRICE#{key}#{when}#inv#0", "product_key": key, "date": when, "price": first_price,
               "quantity": qty, "unit": "шт", "supplier": f"Поставщик {first_key}", "supplier_key": first_key,
               "invoice_id": "inv"})


# ---------- catalog and directory ----------

def test_only_suppliers_have_a_catalog(store, clients):
    setup_accounts(store)
    assert call(SHOP, "GET /catalog")[0] == 403
    assert call(SHOP, "POST /catalog", {"name": "x", "price": 1})[0] == 403
    assert call(SUPPLIER, "GET /catalog")[0] == 200


def test_catalog_crud_and_validation(store, clients):
    setup_accounts(store)
    item = add_item(min_order=2)
    assert call(SUPPLIER, "POST /catalog", {"name": "Без цены"})[0] == 400
    assert call(SUPPLIER, "POST /catalog", {"name": "Минус", "price": -5})[0] == 400
    status, changed = call(SUPPLIER, "PUT /catalog/{id}", {"price": 400, "in_stock": False}, id=item["item_id"])
    assert status == 200 and changed["price"] == 400 and changed["in_stock"] is False and changed["name"] == item["name"]
    assert call(SUPPLIER, "PUT /catalog/{id}", {"price": 1}, id="0123456789")[0] == 404
    assert call(SUPPLIER, "DELETE /catalog/{id}", id=item["item_id"])[0] == 200
    assert call(SUPPLIER, "GET /catalog")[1]["items"] == []


def test_free_catalog_limit_needs_supplier_pro(store, clients, monkeypatch):
    setup_accounts(store)
    monkeypatch.setattr(market, "CATALOG_LIMIT", {"free": 2, "supplier_pro": 5})
    add_item("А"), add_item("Б")
    assert call(SUPPLIER, "POST /catalog", {"name": "В", "price": 1})[0] == 402
    assert call(SUPPLIER, "POST /subscription", {"plan": "supplier_pro", "demo": True})[0] == 200
    assert call(SUPPLIER, "POST /catalog", {"name": "В", "price": 1})[0] == 200


def test_directory_lists_suppliers_and_compares_with_own_prices(store, clients):
    setup_accounts(store)
    add_item("Молоко 3,2% 1 л", 380)
    add_item("Сыр", 3000, in_stock=False)
    put_product(store, "молоко", "молоко 3,2% 1 л", {"a": 420, "b": 400})
    status, body = call(SHOP, "GET /suppliers")
    assert status == 200 and len(body["suppliers"]) == 1
    card = body["suppliers"][0]
    assert card["name"] == "ТОО Молочный двор" and card["items_count"] == 1 and card["supplier_id"] == SUPPLIER
    status, detail = call(SHOP, "GET /suppliers/{id}", id=SUPPLIER)
    milk = next(i for i in detail["items"] if i["name"].startswith("Молоко"))
    assert milk["yours"]["best_price"] == 400 and detail["contact"] == "+7 700 000 00 00"
    assert call(SHOP, "GET /suppliers/{id}", id=SHOP)[0] == 404  # a business is not a supplier


# ---------- orders ----------

def test_order_flow_between_buyer_and_supplier(store, clients):
    setup_accounts(store)
    milk = add_item(price=380, min_order=2)
    assert call(SUPPLIER, "POST /orders", {"supplier_id": SUPPLIER, "lines": []})[0] == 403
    assert call(SHOP, "POST /orders", {"supplier_id": SUPPLIER, "lines": [{"item_id": milk["item_id"], "qty": 1}]})[0] == 400
    status, order = call(SHOP, "POST /orders", {
        "supplier_id": SUPPLIER, "note": "К 8 утра",
        # a forged price in the request must be ignored: the catalog price counts
        "lines": [{"item_id": milk["item_id"], "qty": 10, "price": 1}]})
    assert status == 200 and order["total"] == 3800 and order["status"] == "new" and order["lines"][0]["price"] == 380

    inbox = call(SUPPLIER, "GET /orders")[1]["orders"]
    assert len(inbox) == 1 and inbox[0]["side"] == "seller" and inbox[0]["buyer_name"] == "Кофейня на Абая"
    assert "buyer_id" not in inbox[0]
    assert call(SHOP, "GET /orders")[1]["orders"][0]["side"] == "buyer"

    oid = order["order_id"]
    assert call(SHOP, "PUT /orders/{id}", {"status": "accepted"}, id=oid)[0] == 409  # buyers can only cancel
    assert call(SUPPLIER, "PUT /orders/{id}", {"status": "delivered"}, id=oid)[0] == 409  # accept first
    assert call(SUPPLIER, "PUT /orders/{id}", {"status": "accepted"}, id=oid)[0] == 200
    assert call(SHOP, "GET /orders")[1]["orders"][0]["status"] == "accepted"  # the buyer's copy follows
    assert call(SUPPLIER, "PUT /orders/{id}", {"status": "delivered"}, id=oid)[0] == 200
    assert call("someone-else", "PUT /orders/{id}", {"status": "cancelled"}, id=oid)[0] == 404


def test_order_rejects_unavailable_items(store, clients):
    setup_accounts(store)
    gone = add_item("Сыр", 3000, in_stock=False)
    status, body = call(SHOP, "POST /orders", {"supplier_id": SUPPLIER, "lines": [{"item_id": gone["item_id"], "qty": 1}]})
    assert status == 409 and "нет в наличии" in body["error"]
    assert call(SHOP, "POST /orders", {"supplier_id": "nobody-here", "lines": [{"item_id": "0123456789", "qty": 1}]})[0] == 404


# ---------- subscription and assistant ----------

def test_subscription_is_a_demo_payment(store, clients):
    setup_accounts(store)
    status, view = call(SHOP, "GET /subscription")
    assert status == 200 and view["plan"] == "free" and {p["id"] for p in view["plans"]} == {"free", "pro", "network"}
    assert call(SHOP, "POST /subscription", {"plan": "pro"})[0] == 400  # must be marked as demo
    assert call(SHOP, "POST /subscription", {"plan": "supplier_pro", "demo": True})[0] == 400  # wrong role
    status, view = call(SHOP, "POST /subscription", {"plan": "pro", "demo": True})
    assert status == 200 and view["plan"] == "pro" and view["plan_until"] and view["payments"][0]["demo"] is True
    assert call(SHOP, "GET /settings")[1]["plan"] == "pro"
    # settings saved afterwards must not wipe the plan
    call(SHOP, "PUT /settings", {"threshold_pct": 7})
    assert call(SHOP, "GET /subscription")[1]["plan"] == "pro"
    assert call(SHOP, "POST /subscription", {"plan": "free"})[1]["plan"] == "free"


def test_expired_plan_counts_as_free(store, clients):
    setup_accounts(store)
    call(SHOP, "POST /subscription", {"plan": "pro", "demo": True})
    settings = store.get(db.user_pk(SHOP), "SETTINGS")
    store.put({**settings, "plan_until": "2020-01-01T00:00:00Z"})
    assert call(SHOP, "GET /subscription")[1]["plan"] == "free"


def test_assistant_needs_pro_and_answers_from_the_users_data(store, clients, monkeypatch):
    setup_accounts(store)
    put_product(store, "молоко", "молоко 3,2% 1 л", {"a": 420, "b": 400})
    assert call(SHOP, "POST /assistant", {"question": "Где переплачиваю?"})[0] == 402
    call(SHOP, "POST /subscription", {"plan": "pro", "demo": True})
    seen = {}

    def fake_generate(parts, **kwargs):
        seen["prompt"] = parts[0]["text"]
        return "  Переплата идёт за молоко.  "
    monkeypatch.setattr(gemini, "generate", fake_generate)
    status, body = call(SHOP, "POST /assistant", {"question": "Где переплачиваю?"})
    assert status == 200 and body["answer"] == "Переплата идёт за молоко." and body["fallback"] is False
    assert "молоко 3,2% 1 л" in seen["prompt"] and "Где переплачиваю?" in seen["prompt"]
    assert body["remaining"] == market.ASSISTANT_DAILY_LIMIT - 1
    assert call(SHOP, "POST /assistant", {"question": ""})[0] == 400
    assert call(SHOP, "POST /assistant", {"question": "я" * 501})[0] == 400


def test_assistant_falls_back_when_gemini_is_down_and_respects_the_daily_limit(store, clients, monkeypatch):
    setup_accounts(store)
    put_product(store, "молоко", "молоко 3,2% 1 л", {"a": 420, "b": 400})
    call(SHOP, "POST /subscription", {"plan": "pro", "demo": True})

    def broken(parts, **kwargs):
        raise gemini.GeminiError("down")
    monkeypatch.setattr(gemini, "generate", broken)
    status, body = call(SHOP, "POST /assistant", {"question": "Сколько переплатил?"})
    assert status == 200 and body["fallback"] is True and "переплата" in body["answer"].lower()

    monkeypatch.setattr(gemini, "generate", lambda parts, **kw: "ок")
    monkeypatch.setattr(market, "ASSISTANT_DAILY_LIMIT", 2)
    assert call(SHOP, "POST /assistant", {"question": "1"})[0] == 200
    assert call(SHOP, "POST /assistant", {"question": "2"})[0] == 200
    assert call(SHOP, "POST /assistant", {"question": "3"})[0] == 429


# ---------- savings ----------

def test_savings_counts_only_purchases_above_the_best_price(store, clients):
    setup_accounts(store)
    # bought 10 pcs at 420, supplier b sells it at 400: overpaid 200
    put_product(store, "молоко", "молоко 3,2% 1 л", {"a": 420, "b": 400}, qty=10)
    # only one supplier: nothing to compare with
    put_product(store, "хлеб", "хлеб", {"c": 150}, qty=20)
    # an old purchase outside the 30 days is ignored
    put_product(store, "сыр", "сыр", {"a": 3000, "b": 2500}, qty=1, days_ago=60)
    status, body = call(SHOP, "GET /savings")
    assert status == 200
    assert body["spent"] == 420 * 10 + 150 * 20 and body["overpay"] == 200
    assert [i["name"] for i in body["items"]] == ["молоко 3,2% 1 л"]
    assert body["items"][0]["best_supplier"] == "Поставщик b"
    assert body["by_supplier"] == [{"supplier": "Поставщик a", "overpay": 200}]
    assert call(SUPPLIER, "GET /savings")[0] == 403


# ---------- recipes ----------

def test_recipe_cost_follows_current_prices(store, clients):
    setup_accounts(store)
    put_product(store, "молоко", "молоко 3,2% 1 л", {"a": 400})
    put_product(store, "кофе", "кофе в зёрнах 1 кг", {"a": 8000})
    status, recipe = call(SHOP, "POST /recipes", {
        "name": "Латте", "portions": 20, "menu_price": 1500,
        "ingredients": [{"product_key": "молоко", "qty": 4}, {"product_key": "кофе", "qty": 0.2}]})
    assert status == 200
    assert recipe["total_cost"] == 3200 and recipe["cost_per_portion"] == 160 and recipe["margin_pct"] == 89.3
    # the supplier raised the price: the cost follows, nothing is stored twice
    put_product(store, "молоко", "молоко 3,2% 1 л", {"a": 500})
    updated = call(SHOP, "GET /recipes")[1]["recipes"][0]
    assert updated["total_cost"] == 3600 and updated["cost_per_portion"] == 180

    status, changed = call(SHOP, "PUT /recipes/{id}", {"name": "Латте", "portions": 10, "ingredients": [
        {"product_key": "молоко", "qty": 1}]}, id=recipe["recipe_id"])
    assert status == 200 and changed["menu_price"] is None and changed["margin_pct"] is None
    # an ingredient the user has never bought is reported, not silently priced at 0
    status, ghost = call(SHOP, "POST /recipes", {"name": "Чай", "ingredients": [{"product_key": "чай", "qty": 1}]})
    assert status == 200 and ghost["missing"] == 1 and ghost["total_cost"] == 0
    assert call(SHOP, "POST /recipes", {"name": "Пусто", "ingredients": []})[0] == 400
    assert call(SHOP, "DELETE /recipes/{id}", id=recipe["recipe_id"])[0] == 200


def test_free_plan_keeps_three_recipes(store, clients):
    setup_accounts(store)
    put_product(store, "молоко", "молоко", {"a": 400})
    body = {"name": "x", "ingredients": [{"product_key": "молоко", "qty": 1}]}
    for _ in range(3):
        assert call(SHOP, "POST /recipes", body)[0] == 200
    assert call(SHOP, "POST /recipes", body)[0] == 402
    call(SHOP, "POST /subscription", {"plan": "pro", "demo": True})
    assert call(SHOP, "POST /recipes", body)[0] == 200


def test_admin_overview_counts_suppliers_plans_and_orders(store, clients, monkeypatch):
    from supplyradar import config
    setup_accounts(store)
    call(SHOP, "POST /subscription", {"plan": "pro", "demo": True})
    milk = add_item()
    call(SHOP, "POST /orders", {"supplier_id": SUPPLIER, "lines": [{"item_id": milk["item_id"], "qty": 1}]})
    monkeypatch.setattr(config, "ADMIN_EMAILS", {f"{SHOP}@example.com"})
    status, body = call(SHOP, "GET /admin/overview")
    assert status == 200 and body["suppliers"] == 1 and body["orders"] == 1
    assert body["by_plan"] == {"pro": 1, "free": 1}


def test_product_matching_ignores_decimal_comma_and_case():
    own = [{"name": "молоко 3.2% 1 л", "last_price": 400}, {"name": "хлеб"}]
    assert market.match_product("Молоко 3,2% 1 Л", own) is own[0]
    assert market.match_product("Сыр", own) is None
    assert market.match_product("", own) is None
