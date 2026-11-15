"""Locations, contract prices, claims to suppliers and demo data.

Same (user, params, body) handler shape as api.py and market.py; api.py registers ROUTES.
"""
import hashlib
import logging
import re
import uuid
from datetime import date, datetime, timedelta, timezone

from . import db, market
from .common import ApiError, now_iso, num

log = logging.getLogger()

LOCATION_LIMIT = {"network": 9}  # extra points besides the main one
CONTRACT_LIMIT_FREE = 3
CONTRACT_LIMIT = 200
CLAIM_STATUSES = ("draft", "sent", "resolved", "rejected")
ID_RE = re.compile(r"[0-9a-f]{10}")
CLAIM_ID_RE = re.compile(r"\d{14}-[0-9a-f]{6}")
MAIN = "main"


def _profile(user):
    return db.store().get(db.user_pk(user["id"]), "SETTINGS") or {}


def _business(user):
    profile = _profile(user)
    if profile.get("business_type") == "supplier":
        raise ApiError(403, "Раздел только для бизнеса, не для поставщиков")
    return profile


def _check(value, pattern):
    if not pattern.fullmatch(value or ""):
        raise ApiError(400, "Некорректный идентификатор")
    return value


# ---------- locations ----------

def _locations(pk):
    return db.store().query_prefix(pk, "LOC#")


def location_known(pk, location_id):
    """Invoices may be tagged with the main point (no tag) or with one of the stored points."""
    if location_id in (None, "", MAIN):
        return None
    if not db.store().get(pk, f"LOC#{location_id}"):
        raise ApiError(400, "Такой точки нет")
    return location_id


def list_locations(user, params, body):
    profile = _business(user)
    pk = db.user_pk(user["id"])
    stored = sorted(_locations(pk), key=lambda l: str(l.get("name")).lower())
    known = {l["location_id"] for l in stored}
    since = (date.today() - timedelta(days=30)).isoformat()
    invoices = [i for i in db.store().query_prefix(pk, "INV#") if i.get("status") in ("checked", "confirmed")
                and str(i.get("invoice_date") or i.get("created_at") or "")[:10] >= since]
    rows = [{"location_id": MAIN, "name": profile.get("business_name") or "Основная точка", "address": None, "main": True}]
    rows += [{"location_id": l["location_id"], "name": l["name"], "address": l.get("address"), "main": False} for l in stored]
    for row in rows:
        s = market.compute_savings(pk, 30, row["location_id"], known)
        mine = [i for i in invoices if (i.get("location_id") if i.get("location_id") in known else MAIN) == row["location_id"]]
        row.update(invoices=len(mine), spent=s["spent"], overpay=s["overpay"], overpay_pct=s["overpay_pct"])
    plan = market.plan_of(profile)
    return {"locations": rows, "limit": LOCATION_LIMIT.get(plan, 0) + 1, "plan": plan}


def _location_from_body(body):
    name = str(body.get("name") or "").strip()
    if not 1 <= len(name) <= 60:
        raise ApiError(400, "Название точки: от 1 до 60 символов")
    return {"name": name, "address": str(body.get("address") or "").strip()[:120] or None}


def create_location(user, params, body):
    profile = _business(user)
    pk = db.user_pk(user["id"])
    limit = LOCATION_LIMIT.get(market.plan_of(profile), 0)
    if len(_locations(pk)) >= limit:
        raise ApiError(402, "Несколько точек в одном аккаунте входят в тариф «Сеть»")
    location_id = uuid.uuid4().hex[:10]
    item = {"PK": pk, "SK": f"LOC#{location_id}", "location_id": location_id, **_location_from_body(body),
            "created_at": now_iso()}
    db.store().put(item)
    return {k: item[k] for k in ("location_id", "name", "address")}


def update_location(user, params, body):
    _business(user)
    location_id = _check(params.get("id"), ID_RE)
    pk = db.user_pk(user["id"])
    current = db.store().get(pk, f"LOC#{location_id}")
    if not current:
        raise ApiError(404, "Точка не найдена")
    item = {**current, **_location_from_body({**current, **body})}
    db.store().put(item)
    return {k: item[k] for k in ("location_id", "name", "address")}


def delete_location(user, params, body):
    _business(user)
    location_id = _check(params.get("id"), ID_RE)
    # Invoices tagged with this point fall back to the main point; nothing is lost.
    db.store().delete(db.user_pk(user["id"]), f"LOC#{location_id}")
    return {"deleted": location_id}


# ---------- contract prices ----------

CONTRACT_FIELDS = ("contract_id", "product_key", "product_name", "supplier_key", "supplier_name", "price",
                   "tolerance_pct", "created_at")


def _contract_id(product_key, supplier_key):
    return hashlib.sha1(f"{product_key}|{supplier_key}".encode()).hexdigest()[:10]


def _contract_view(c, product):
    entry = ((product or {}).get("suppliers") or {}).get(c["supplier_key"]) or {}
    actual = entry.get("price")
    deviation = round((actual - c["price"]) / c["price"] * 100, 1) if actual else None
    tol = c.get("tolerance_pct") or 0
    status = "no_data" if deviation is None else "over" if deviation > tol else "ok"
    return {**{f: c.get(f) for f in CONTRACT_FIELDS}, "actual_price": actual, "actual_date": entry.get("date"),
            "invoice_id": entry.get("invoice_id"), "deviation_pct": deviation, "status": status}


def _contract_overpay(pk, c):
    """Paid above the contract price (beyond the tolerance) in deliveries since the contract was set up."""
    since = str(c.get("created_at") or "")[:10]
    limit = c["price"] * (1 + (c.get("tolerance_pct") or 0) / 100)
    extra = 0.0
    for row in db.store().query_prefix(pk, f"PRICE#{c['product_key']}#"):
        if row.get("supplier_key") == c["supplier_key"] and row.get("price", 0) > limit and str(row.get("date")) >= since:
            extra += (row["price"] - c["price"]) * (row.get("quantity") or 1)
    return round(extra)


def list_contracts(user, params, body):
    profile = _business(user)
    pk = db.user_pk(user["id"])
    store = db.store()
    products = {p["product_key"]: p for p in store.query_prefix(pk, "PROD#")}
    contracts = [_contract_view(c, products.get(c["product_key"])) for c in store.query_prefix(pk, "CONTRACT#")]
    for view in contracts:
        view["overpay"] = _contract_overpay(pk, view) if view["status"] == "over" else 0
    contracts.sort(key=lambda c: (c["status"] != "over", str(c["product_name"]).lower()))
    taken = {(c["product_key"], c["supplier_key"]) for c in contracts}
    candidates = [{"product_key": k, "product_name": p.get("name"), "supplier_key": sk, "supplier_name": s.get("name"),
                   "last_price": s.get("price")}
                  for k, p in products.items() for sk, s in (p.get("suppliers") or {}).items() if (k, sk) not in taken]
    candidates.sort(key=lambda c: (str(c["product_name"]).lower(), str(c["supplier_name"]).lower()))
    plan = market.plan_of(profile)
    return {"contracts": contracts, "candidates": candidates, "violations": sum(c["status"] == "over" for c in contracts),
            "overpay": sum(c["overpay"] for c in contracts),
            "limit": CONTRACT_LIMIT if plan in market.ASSISTANT_PLANS else CONTRACT_LIMIT_FREE}


def put_contract(user, params, body):
    profile = _business(user)
    pk = db.user_pk(user["id"])
    store = db.store()
    product_key, supplier_key = str(body.get("product_key") or ""), str(body.get("supplier_key") or "")
    product = store.get(pk, f"PROD#{product_key}") if product_key and "#" not in product_key else None
    entry = ((product or {}).get("suppliers") or {}).get(supplier_key)
    if not entry:
        raise ApiError(404, "У этого поставщика нет такого товара в ваших накладных")
    price = num(body.get("price"), "price")
    if not 0 < price <= 100_000_000:
        raise ApiError(400, "Цена по договору должна быть больше нуля")
    tolerance = num(body.get("tolerance_pct"), "tolerance_pct", required=False)
    tolerance = 2.0 if tolerance is None else tolerance
    if not 0 <= tolerance <= 50:
        raise ApiError(400, "Допуск от 0 до 50 %")
    contract_id = _contract_id(product_key, supplier_key)
    current = store.get(pk, f"CONTRACT#{contract_id}")
    if not current:
        limit = CONTRACT_LIMIT if market.plan_of(profile) in market.ASSISTANT_PLANS else CONTRACT_LIMIT_FREE
        if len(store.query_prefix(pk, "CONTRACT#")) >= limit:
            raise ApiError(402, f"Бесплатно можно следить за {limit} договорными ценами. Без ограничений: тариф Pro.")
    item = {"PK": pk, "SK": f"CONTRACT#{contract_id}", "contract_id": contract_id, "product_key": product_key,
            "product_name": product.get("name"), "supplier_key": supplier_key, "supplier_name": entry.get("name"),
            "price": price, "tolerance_pct": tolerance, "created_at": (current or {}).get("created_at") or now_iso()}
    store.put(item)
    return _contract_view(item, product)


def delete_contract(user, params, body):
    _business(user)
    contract_id = _check(params.get("id"), ID_RE)
    db.store().delete(db.user_pk(user["id"]), f"CONTRACT#{contract_id}")
    return {"deleted": contract_id}


# ---------- claims to suppliers ----------

CLAIM_FIELDS = ("claim_id", "kind", "invoice_id", "product_key", "product_name", "supplier_name", "subject", "text",
                "amount", "status", "refund", "created_at", "updated_at")


def _money(v):
    return f"{v:,.0f}".replace(",", " ") + " ₸"


def _sign(profile, user):
    return profile.get("business_name") or user.get("email") or ""


def _claim_text(kind, ctx, signature):
    """A polite, factual message with the numbers; the owner reads and sends it from their own mail."""
    where = f"в накладной № {ctx['number']} от {ctx['date']}" if ctx.get("number") else f"в накладной от {ctx['date']}"
    qty = f" Объём поставки: {ctx['qty']:g} {ctx.get('unit') or 'шт'}." if ctx.get("qty") else ""
    if kind == "contract":
        body = (f"По договору цена на «{ctx['product']}» составляет {_money(ctx['expected'])}, а {where} указано "
                f"{_money(ctx['actual'])} (на {ctx['pct']:g}% выше).{qty} Разница за поставку: {_money(ctx['amount'])}. "
                "Просим выполнить перерасчёт или объяснить расхождение.")
    else:
        body = (f"{where[0].upper()}{where[1:]} цена на «{ctx['product']}» составила {_money(ctx['actual'])} "
                f"вместо {_money(ctx['expected'])} в прошлой поставке (+{ctx['pct']:g}%).{qty} "
                f"Разница за поставку: {_money(ctx['amount'])}. ")
        if ctx.get("cheaper_pct"):
            body += f"Нам предлагают этот товар дешевле примерно на {ctx['cheaper_pct']:g}%, поэтому просим пересмотреть цену. "
        body += "Если возможно, верните прежнюю цену или подтвердите причину изменения."
    return f"Здравствуйте!\n\n{body}\n\nС уважением,\n{signature}".rstrip()


def create_claim(user, params, body):
    profile = _business(user)
    pk = db.user_pk(user["id"])
    store = db.store()
    kind = body.get("kind")
    if kind == "contract":
        contract_id = _check(str(body.get("contract_id") or ""), ID_RE)
        contract = store.get(pk, f"CONTRACT#{contract_id}")
        product = store.get(pk, f"PROD#{contract['product_key']}") if contract else None
        view = _contract_view(contract, product) if contract else None
        if not view or view["status"] != "over":
            raise ApiError(409, "По этому договору сейчас нет превышения цены")
        invoice = store.get(pk, f"INV#{view['invoice_id']}") if view["invoice_id"] else None
        qty = next((l.get("quantity") for l in (invoice or {}).get("lines", []) if l.get("product_key") == contract["product_key"]), None)
        amount = round((view["actual_price"] - contract["price"]) * (qty or 1))
        ctx = {"product": contract["product_name"], "number": (invoice or {}).get("invoice_number"),
               "date": (view.get("actual_date") or "")[:10], "expected": contract["price"], "actual": view["actual_price"],
               "pct": view["deviation_pct"], "qty": qty, "unit": (product or {}).get("unit"), "amount": amount}
        meta = {"invoice_id": view["invoice_id"], "product_key": contract["product_key"], "product_name": contract["product_name"],
                "supplier_name": contract["supplier_name"]}
    elif kind == "alert":
        invoice_id, product_key = str(body.get("invoice_id") or ""), str(body.get("product_key") or "")
        alert = next((a for a in store.query_prefix(pk, "ALERT#", newest_first=True, limit=200)
                      if a.get("invoice_id") == invoice_id and a.get("product_key") == product_key), None)
        if not alert:
            raise ApiError(404, "Алерт не найден")
        invoice = store.get(pk, f"INV#{invoice_id}") or {}
        product = store.get(pk, f"PROD#{product_key}") or {}
        qty = alert.get("quantity")
        amount = round((alert["new_price"] - alert["old_price"]) * (qty or 1))
        ctx = {"product": alert["product"], "number": invoice.get("invoice_number"), "date": str(alert.get("invoice_date") or "")[:10],
               "expected": alert["old_price"], "actual": alert["new_price"], "pct": alert["change_pct"], "qty": qty,
               "unit": product.get("unit"), "amount": amount, "cheaper_pct": alert.get("cheaper_pct")}
        meta = {"invoice_id": invoice_id, "product_key": product_key, "product_name": alert["product"],
                "supplier_name": alert.get("supplier")}
    else:
        raise ApiError(400, "Укажите kind: alert или contract")
    created = now_iso()
    claim_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]
    claim = {"PK": pk, "SK": f"CLAIM#{claim_id}", "claim_id": claim_id, "kind": kind, **meta,
             "subject": f"Расхождение цены: {meta['product_name']}" + (f", накладная № {ctx['number']}" if ctx.get("number") else ""),
             "text": _claim_text(kind, ctx, _sign(profile, user)), "amount": amount, "status": "draft", "refund": None,
             "created_at": created, "updated_at": created}
    store.put(claim)
    return {f: claim.get(f) for f in CLAIM_FIELDS}


def list_claims(user, params, body):
    _business(user)
    items = db.store().query_prefix(db.user_pk(user["id"]), "CLAIM#", newest_first=True, limit=100)
    return {"claims": [{f: c.get(f) for f in CLAIM_FIELDS} for c in items],
            "refunded": sum(c.get("refund") or 0 for c in items if c.get("status") == "resolved")}


def update_claim(user, params, body):
    _business(user)
    claim_id = _check(params.get("id"), CLAIM_ID_RE)
    pk = db.user_pk(user["id"])
    claim = db.store().get(pk, f"CLAIM#{claim_id}")
    if not claim:
        raise ApiError(404, "Претензия не найдена")
    status = body.get("status", claim["status"])
    if status not in CLAIM_STATUSES:
        raise ApiError(400, "Неизвестный статус")
    refund = claim.get("refund")
    if status == "resolved":
        refund = num(body.get("refund"), "refund", required=False)
        if refund is not None and not 0 <= refund <= 1_000_000_000:
            raise ApiError(400, "Сумма возврата некорректна")
        refund = refund if refund is not None else claim.get("amount")
    claim = {**claim, "status": status, "refund": refund, "updated_at": now_iso()}
    db.store().put(claim)
    return {f: claim.get(f) for f in CLAIM_FIELDS}


# ---------- demo data for the first sign-in ----------

DEMO_SUPPLIERS = {"demo-a": "ТОО Молочный двор (демо)", "demo-b": "ТОО Свежая ферма (демо)"}
# (days ago, supplier, invoice number, [(product key, name, unit, quantity, price)])
DEMO_INVOICES = [
    (42, "demo-a", "1801", [("demo-milk", "молоко 3.2% 1 л", "шт", 60, 400), ("demo-cream", "сливки 33% 0.5 л", "шт", 20, 1500),
                            ("demo-flour", "мука пшеничная в/с 50 кг", "меш", 2, 14500)]),
    (21, "demo-b", "507", [("demo-milk", "молоко 3.2% 1 л", "шт", 40, 380), ("demo-cream", "сливки 33% 0.5 л", "шт", 15, 1420)]),
    (4, "demo-a", "1866", [("demo-milk", "молоко 3.2% 1 л", "шт", 60, 440), ("demo-cream", "сливки 33% 0.5 л", "шт", 20, 1680),
                           ("demo-flour", "мука пшеничная в/с 50 кг", "меш", 2, 15200)]),
]


def _is_demo(key):
    return str(key or "").startswith("demo-")


def seed_demo(user, params, body):
    """A small believable history: two suppliers, three deliveries, one price rise. Flagged so it can be removed."""
    _business(user)
    from validate import record_prices  # the same code path real invoices take: products, prices, alerts

    pk = db.user_pk(user["id"])
    store = db.store()
    if any(i.get("demo") for i in store.query_prefix(pk, "INV#")):
        raise ApiError(409, "Демо-данные уже загружены")
    for days_ago, skey, number, lines in DEMO_INVOICES:
        when = date.today() - timedelta(days=days_ago)
        stamp = datetime(when.year, when.month, when.day, 9, 30, tzinfo=timezone.utc)
        invoice_id = stamp.strftime("%Y%m%d%H%M%S") + "-d3d3d3" + number[-2:].rjust(2, "0")
        rows = [{"name": n.upper(), "canonical_name": n, "product_key": k, "quantity": q, "unit": u, "price": p,
                 "total": round(q * p, 2)} for k, n, u, q, p in lines]
        inv = {"PK": pk, "SK": f"INV#{invoice_id}", "invoice_id": invoice_id, "user_id": user["id"], "demo": True,
               "status": "checked", "supplier_name": DEMO_SUPPLIERS[skey], "supplier_key": skey, "supplier_bin": "",
               "invoice_number": number, "invoice_date": when.isoformat(), "currency": "KZT",
               "total": round(sum(r["total"] for r in rows), 2), "lines": rows, "issues": [],
               "created_at": stamp.strftime("%Y-%m-%dT%H:%M:%SZ")}
        store.put(inv)
        record_prices(store, pk, inv)
    # Every item this wrote is recognisable by its demo key, so the cleanup below needs no extra flags.
    for item in store.query_prefix(pk, "ALERT#"):
        if _is_demo(item.get("product_key")):
            store.put({**item, "demo": True})
    return {"invoices": len(DEMO_INVOICES)}


def clear_demo(user, params, body):
    _business(user)
    pk = db.user_pk(user["id"])
    store = db.store()
    removed = 0
    for prefix in ("INV#", "PROD#", "PRICE#", "ALERT#", "ALIAS#", "DUP#", "CONTRACT#", "CLAIM#"):
        for item in store.query_prefix(pk, prefix):
            if item.get("demo") or _is_demo(item.get("product_key")) or _is_demo(item.get("supplier_key")):
                store.delete(pk, item["SK"])
                removed += 1
    for rec in store.query_prefix(pk, "RECIPE#"):  # a recipe made of demo products would price at zero
        if any(_is_demo(i.get("product_key")) for i in rec.get("ingredients") or []):
            store.delete(pk, rec["SK"])
            removed += 1
    return {"removed": removed}


ROUTES = {
    "GET /locations": list_locations,
    "POST /locations": create_location,
    "PUT /locations/{id}": update_location,
    "DELETE /locations/{id}": delete_location,
    "GET /contracts": list_contracts,
    "PUT /contracts": put_contract,
    "DELETE /contracts/{id}": delete_contract,
    "GET /claims": list_claims,
    "POST /claims": create_claim,
    "PUT /claims/{id}": update_claim,
    "POST /demo": seed_demo,
    "DELETE /demo": clear_demo,
}
