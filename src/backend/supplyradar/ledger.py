"""Sales with receipts, expenses, stock, period reports with a tax draft, tax calendar and accountant access.

What the business hands to the outside world: a receipt for the buyer, journals and a draft declaration for the
accountant, an order to the supplier when stock runs low. The tax draft is arithmetic on the owner's own numbers
with the rate the owner enters; the app never files anything.

Same (user, params, body) handler shape as api.py; api.py registers ROUTES. Query string values arrive in params.
"""
import calendar
import re
import uuid
from datetime import date, datetime, timedelta, timezone

from . import db, market
from .common import ApiError, now_iso, num

PAYMENTS = {"cash": "Наличные", "card": "Карта", "transfer": "Перевод"}
EXPENSE_CATEGORIES = {"rent": "Аренда", "salary": "Зарплата", "utilities": "Коммунальные услуги",
                      "taxes": "Налоги и сборы", "transport": "Транспорт", "marketing": "Реклама",
                      "equipment": "Оборудование", "other": "Прочее"}
REPEATS = ("none", "monthly", "quarterly", "semiannual", "yearly")
TAX_TEMPLATES = [
    {"title": "Сдать налоговую декларацию по своему режиму", "repeat": "semiannual"},
    {"title": "Уплатить налог по декларации", "repeat": "semiannual"},
    {"title": "Социальные платежи и ОПВ за себя", "repeat": "monthly"},
    {"title": "Отчёт и платежи за работников", "repeat": "monthly"},
]
SALE_ID_RE = re.compile(r"\d{14}-[0-9a-f]{6}")
EXP_ID_RE = re.compile(r"[0-9a-f]{10}")
EMAIL_RE = re.compile(r"^[^@\s#]+@[^@\s#]+\.[^@\s#]+$")
SUB_RE = re.compile(r"[\w-]{1,64}")
PERIOD_RE = re.compile(r"(\d{4})(?:-(\d{2})|-Q([1-4])|-H([12]))?")
ACCESS_LIMIT = 5
SALE_LINES = 50


def _profile(pk):
    return db.store().get(pk, "SETTINGS") or {}


def _business(user):
    pk = db.user_pk(user["id"])
    profile = _profile(pk)
    if profile.get("business_type") == "supplier":
        raise ApiError(403, "Раздел только для бизнеса, не для поставщиков")
    return pk, profile


def _new_id():
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]


def _money(v):
    return f"{v:,.0f}".replace(",", " ") + " ₸"


def _strip(item):
    return {k: v for k, v in item.items() if k not in ("PK", "SK")}


# ---------- sales and receipts ----------

def _sellables(pk):
    """What can go on a receipt: dishes with a menu price and purchased products, each with its unit cost now."""
    products = {p["product_key"]: p for p in db.store().query_prefix(pk, "PROD#")}
    stock = {s["product_key"]: s for s in db.store().query_prefix(pk, "STOCK#")}
    items = []
    for r in db.store().query_prefix(pk, "RECIPE#"):
        view = market._recipe_view(r, products)
        items.append({"kind": "recipe", "key": r["recipe_id"], "name": r["name"], "price": r.get("menu_price"),
                      "unit": "порц", "unit_cost": view["cost_per_portion"] if not view["missing"] else None})
    for key, p in products.items():
        items.append({"kind": "product", "key": key, "name": p.get("name") or key,
                      "price": (stock.get(key) or {}).get("sale_price"), "unit": p.get("unit"),
                      "unit_cost": p.get("last_price")})
    items.sort(key=lambda i: str(i["name"]).lower())
    return items


def _next_number(pk):
    store = db.store()
    seq = store.get(pk, "SEQ#sale") or {"PK": pk, "SK": "SEQ#sale", "value": 0}
    seq["value"] = int(seq.get("value") or 0) + 1
    store.put(seq)
    return seq["value"]


def create_sale(user, params, body):
    pk, profile = _business(user)
    payment = body.get("payment")
    if payment not in PAYMENTS:
        raise ApiError(400, "Выберите способ оплаты: наличные, карта или перевод")
    raw = body.get("lines")
    if not isinstance(raw, list) or not 1 <= len(raw) <= SALE_LINES:
        raise ApiError(400, f"Добавьте от 1 до {SALE_LINES} позиций")
    known = {(i["kind"], i["key"]): i for i in _sellables(pk)}
    lines = []
    for line in raw:
        line = line or {}
        kind, key = line.get("kind"), str(line.get("key") or "")
        name = str(line.get("name") or "").strip()[:80]
        item = known.get((kind, key))
        if kind == "free":
            if not name:
                raise ApiError(400, "Укажите название позиции")
            item = {"name": name, "unit": "шт", "unit_cost": None}
        elif not item:
            raise ApiError(400, "Такой позиции нет в меню или товарах")
        qty = num(line.get("qty"), "qty")
        price = num(line.get("price"), "price")
        if not 0 < qty <= 100_000:
            raise ApiError(400, "Количество должно быть больше нуля")
        if not 0 <= price <= 100_000_000:
            raise ApiError(400, "Цена некорректна")
        cost = item.get("unit_cost")
        lines.append({"kind": kind, "key": key or None, "name": item["name"], "unit": item.get("unit"), "qty": qty,
                      "price": price, "total": round(qty * price, 2),
                      "unit_cost": round(cost, 2) if cost is not None else None})
    discount = num(body.get("discount"), "discount", required=False) or 0
    subtotal = round(sum(l["total"] for l in lines), 2)
    if not 0 <= discount <= subtotal:
        raise ApiError(400, "Скидка не может быть больше суммы чека")
    sale_id = _new_id()
    created = now_iso()
    sale = {"PK": pk, "SK": f"SALE#{sale_id}", "sale_id": sale_id, "number": _next_number(pk), "lines": lines,
            "subtotal": subtotal, "discount": discount, "total": round(subtotal - discount, 2), "payment": payment,
            "status": "paid", "refund_reason": None, "created_at": created, "date": created[:10]}
    db.store().put(sale)
    return _receipt(sale, profile, user)


def _receipt(sale, profile, user):
    return {**_strip(sale), "payment_name": PAYMENTS.get(sale["payment"]),
            "seller": {"name": profile.get("business_name") or user.get("email"), "bin": profile.get("bin"),
                       "address": profile.get("address")}}


def list_sales(user, params, body):
    pk, profile = _business(user)
    day = params.get("date") or date.today().isoformat()
    try:
        date.fromisoformat(day)
    except ValueError:
        raise ApiError(400, "Дата в формате ГГГГ-ММ-ДД")
    sales = [s for s in db.store().query_prefix(pk, "SALE#", newest_first=True) if s.get("date") == day]
    paid = [s for s in sales if s["status"] == "paid"]
    by_payment = {k: round(sum(s["total"] for s in paid if s["payment"] == k), 2) for k in PAYMENTS}
    return {"date": day, "sales": [_strip(s) for s in sales], "total": round(sum(s["total"] for s in paid), 2),
            "by_payment": by_payment, "payments": PAYMENTS, "count": len(paid), "sellables": _sellables(pk)}


def _sale(pk, sale_id):
    if not SALE_ID_RE.fullmatch(sale_id or ""):
        raise ApiError(400, "Некорректный номер чека")
    sale = db.store().get(pk, f"SALE#{sale_id}")
    if not sale:
        raise ApiError(404, "Чек не найден")
    return sale


def get_sale(user, params, body):
    pk, profile = _business(user)
    return _receipt(_sale(pk, params.get("id")), profile, user)


def refund_sale(user, params, body):
    pk, profile = _business(user)
    sale = _sale(pk, params.get("id"))
    if sale["status"] == "refunded":
        raise ApiError(409, "Чек уже возвращён")
    reason = str(body.get("reason") or "").strip()[:200]
    if not reason:
        raise ApiError(400, "Укажите причину возврата")
    sale = {**sale, "status": "refunded", "refund_reason": reason, "refunded_at": now_iso()}
    db.store().put(sale)
    return _receipt(sale, profile, user)


# ---------- expenses ----------

def _expense_from_body(body):
    category = body.get("category")
    if category not in EXPENSE_CATEGORIES:
        raise ApiError(400, "Выберите категорию расхода")
    amount = num(body.get("amount"), "amount")
    if not 0 < amount <= 10_000_000_000:
        raise ApiError(400, "Сумма должна быть больше нуля")
    day = str(body.get("date") or date.today().isoformat())
    try:
        date.fromisoformat(day)
    except ValueError:
        raise ApiError(400, "Дата в формате ГГГГ-ММ-ДД")
    return {"category": category, "amount": amount, "date": day, "note": str(body.get("note") or "").strip()[:120] or None}


def _materialize_monthly(pk):
    """A monthly expense (rent, internet) appears once in every month from its first date up to the current one."""
    store = db.store()
    this_month = date.today().isoformat()[:7]
    for t in store.query_prefix(pk, "EXPT#"):
        month = t["date"][:7]
        while month <= this_month:
            y, m = int(month[:4]), int(month[5:])
            day = min(int(t["date"][8:]), calendar.monthrange(y, m)[1])
            sk = f"EXP#{month}-{day:02d}#t{t['expense_id']}"
            if not store.get(pk, sk) and not store.get(pk, f"EXP#{month}-00#t{t['expense_id']}"):
                store.put({"PK": pk, "SK": sk, "expense_id": f"t{t['expense_id']}-{month}", "template_id": t["expense_id"],
                           "category": t["category"], "amount": t["amount"], "note": t.get("note"),
                           "date": f"{month}-{day:02d}", "monthly": True, "created_at": now_iso()})
            m += 1
            month = f"{y + (m > 12)}-{(m - 1) % 12 + 1:02d}"


def _expenses(pk, start, end):
    _materialize_monthly(pk)
    return [e for e in db.store().query_prefix(pk, "EXP#") if start <= e["date"] <= end]


def list_expenses(user, params, body):
    pk, profile = _business(user)
    month = params.get("month") or date.today().isoformat()[:7]
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise ApiError(400, "Месяц в формате ГГГГ-ММ")
    rows = sorted(_expenses(pk, f"{month}-01", f"{month}-31"), key=lambda e: (e["date"], e["SK"]), reverse=True)
    by_category = {}
    for e in rows:
        by_category[e["category"]] = round(by_category.get(e["category"], 0) + e["amount"], 2)
    return {"month": month, "expenses": [_strip(e) for e in rows], "total": round(sum(e["amount"] for e in rows), 2),
            "by_category": by_category, "categories": EXPENSE_CATEGORIES,
            "monthly": [_strip(t) for t in db.store().query_prefix(pk, "EXPT#")]}


def create_expense(user, params, body):
    pk, profile = _business(user)
    data = _expense_from_body(body)
    expense_id = uuid.uuid4().hex[:10]
    if body.get("monthly"):
        db.store().put({"PK": pk, "SK": f"EXPT#{expense_id}", "expense_id": expense_id, **data, "created_at": now_iso()})
        _materialize_monthly(pk)
        return {"expense_id": expense_id, "monthly": True, **data}
    item = {"PK": pk, "SK": f"EXP#{data['date']}#{expense_id}", "expense_id": expense_id, **data, "created_at": now_iso()}
    db.store().put(item)
    return _strip(item)


def delete_expense(user, params, body):
    """Deletes one expense; for a monthly one, `all=1` stops the repeat and removes this month's copy too."""
    pk, profile = _business(user)
    expense_id = params.get("id") or ""
    store = db.store()
    if re.fullmatch(r"t[0-9a-f]{10}-\d{4}-\d{2}", expense_id):
        template = expense_id[1:11]
        for e in store.query_prefix(pk, "EXP#"):
            if e.get("expense_id") == expense_id:
                store.delete(pk, e["SK"])
        if params.get("all") in ("1", "true"):
            store.delete(pk, f"EXPT#{template}")
            for e in store.query_prefix(pk, "EXP#"):
                if e.get("template_id") == template and e["date"][:7] >= date.today().isoformat()[:7]:
                    store.delete(pk, e["SK"])
        else:  # keep the repeat but remember this month was removed on purpose
            month = expense_id[-7:]
            store.put({"PK": pk, "SK": f"EXP#{month}-00#t{template}", "expense_id": expense_id, "template_id": template,
                       "category": "other", "amount": 0, "date": f"{month}-00", "skipped": True})
        return {"deleted": expense_id}
    if not EXP_ID_RE.fullmatch(expense_id):
        raise ApiError(400, "Некорректный идентификатор")
    hit = [e for e in store.query_prefix(pk, "EXP#") if e.get("expense_id") == expense_id]
    if not hit:
        raise ApiError(404, "Расход не найден")
    store.delete(pk, hit[0]["SK"])
    return {"deleted": expense_id}


# ---------- stock ----------

def _stock_rows(pk):
    store = db.store()
    products = {p["product_key"]: p for p in store.query_prefix(pk, "PROD#")}
    recipes = {r["recipe_id"]: r for r in store.query_prefix(pk, "RECIPE#")}
    settings = {s["product_key"]: s for s in store.query_prefix(pk, "STOCK#")}
    came = {}
    for row in store.query_prefix(pk, "PRICE#"):
        came[row["product_key"]] = came.get(row["product_key"], 0) + (row.get("quantity") or 0)
    went = {}
    for sale in store.query_prefix(pk, "SALE#"):
        if sale.get("status") != "paid":
            continue
        for line in sale.get("lines") or []:
            if line["kind"] == "product":
                went[line["key"]] = went.get(line["key"], 0) + line["qty"]
            elif line["kind"] == "recipe" and line["key"] in recipes:
                r = recipes[line["key"]]
                for ing in r.get("ingredients") or []:
                    used = ing["qty"] * line["qty"] / (r.get("portions") or 1)
                    went[ing["product_key"]] = went.get(ing["product_key"], 0) + used
    rows = []
    for key, p in products.items():
        s = settings.get(key) or {}
        on_hand = round(came.get(key, 0) - went.get(key, 0) + (s.get("adjust") or 0), 3)
        offers = sorted(((o.get("price"), o.get("name")) for o in (p.get("suppliers") or {}).values() if o.get("price")),
                        key=lambda o: o[0])
        rows.append({"product_key": key, "name": p.get("name") or key, "unit": p.get("unit"), "received": round(came.get(key, 0), 3),
                     "sold": round(went.get(key, 0), 3), "adjust": s.get("adjust") or 0, "on_hand": on_hand,
                     "min_qty": s.get("min_qty"), "sale_price": s.get("sale_price"),
                     "low": s.get("min_qty") is not None and on_hand <= s["min_qty"],
                     "best_price": offers[0][0] if offers else None, "best_supplier": offers[0][1] if offers else None,
                     "last_supplier": (p.get("suppliers") or {}).get(p.get("last_supplier_key"), {}).get("name")
                     or (offers[0][1] if offers else None)})
    rows.sort(key=lambda r: (not r["low"], str(r["name"]).lower()))
    return rows


def _order_texts(rows, signature):
    """One message per supplier for every low item: bring it back to twice the minimum."""
    groups = {}
    for r in rows:
        if not r["low"]:
            continue
        need = max(r["min_qty"] * 2 - r["on_hand"], r["min_qty"] or 1)
        groups.setdefault(r["best_supplier"] or "Поставщик", []).append((r, round(need, 2)))
    orders = []
    for supplier, items in groups.items():
        lines = "\n".join(f"- {r['name']}: {q:g} {r['unit'] or 'шт'}" for r, q in items)
        total = sum((r["best_price"] or 0) * q for r, q in items)
        orders.append({"supplier": supplier, "items": [{"product_key": r["product_key"], "name": r["name"], "qty": q,
                                                        "unit": r["unit"], "price": r["best_price"]} for r, q in items],
                       "total": round(total, 2),
                       "text": f"Здравствуйте!\n\nПросим привезти:\n{lines}\n\nОриентировочно на {_money(total)} по вашим последним ценам. "
                               f"Подтвердите, пожалуйста, наличие и дату доставки.\n\nС уважением,\n{signature}".rstrip()})
    return orders


def list_stock(user, params, body):
    pk, profile = _business(user)
    rows = _stock_rows(pk)
    return {"stock": rows, "low": sum(r["low"] for r in rows),
            "orders": _order_texts(rows, profile.get("business_name") or user.get("email") or "")}


def put_stock(user, params, body):
    pk, profile = _business(user)
    key = str(params.get("key") or "")
    if not key or "#" in key or len(key) > 100 or not db.store().get(pk, f"PROD#{key}"):
        raise ApiError(404, "Товар не найден")
    store = db.store()
    item = store.get(pk, f"STOCK#{key}") or {"PK": pk, "SK": f"STOCK#{key}", "product_key": key}
    if "min_qty" in body:
        v = num(body.get("min_qty"), "min_qty", required=False)
        if v is not None and not 0 <= v <= 1_000_000:
            raise ApiError(400, "Минимальный остаток некорректен")
        item["min_qty"] = v
    if "sale_price" in body:
        v = num(body.get("sale_price"), "sale_price", required=False)
        if v is not None and not 0 <= v <= 100_000_000:
            raise ApiError(400, "Цена продажи некорректна")
        item["sale_price"] = v
    if "count" in body:  # stocktaking: the counted amount becomes the balance, the difference is written off
        counted = num(body.get("count"), "count")
        if not 0 <= counted <= 10_000_000:
            raise ApiError(400, "Фактический остаток некорректен")
        current = next(r for r in _stock_rows(pk) if r["product_key"] == key)
        item["adjust"] = round((item.get("adjust") or 0) + counted - current["on_hand"], 3)
        item["counted_at"] = now_iso()
    item["updated_at"] = now_iso()
    store.put(item)
    return next(r for r in _stock_rows(pk) if r["product_key"] == key)


# ---------- reports and the tax draft ----------

def parse_period(value):
    """2026-11 (month), 2026-Q4 (quarter), 2026-H2 (half-year) or 2026 (year) -> (label, start, end)."""
    m = PERIOD_RE.fullmatch(value or "")
    if not m:
        raise ApiError(400, "Период: ГГГГ-ММ, ГГГГ-Q1..Q4, ГГГГ-H1/H2 или ГГГГ")
    y = int(m.group(1))
    if m.group(2):
        mo = int(m.group(2))
        if not 1 <= mo <= 12:
            raise ApiError(400, "Нет такого месяца")
        first, last = mo, mo
    elif m.group(3):
        q = int(m.group(3))
        first, last = 3 * q - 2, 3 * q
    elif m.group(4):
        h = int(m.group(4))
        first, last = 6 * h - 5, 6 * h
    else:
        first, last = 1, 12
    start = date(y, first, 1)
    end = date(y, last, calendar.monthrange(y, last)[1])
    return value, start.isoformat(), end.isoformat()


def build_report(pk, period):
    label, start, end = parse_period(period)
    store = db.store()
    profile = _profile(pk)
    sales = [s for s in store.query_prefix(pk, "SALE#") if start <= s.get("date", "") <= end]
    paid = [s for s in sales if s["status"] == "paid"]
    refunded = [s for s in sales if s["status"] == "refunded"]
    invoices = [i for i in store.query_prefix(pk, "INV#")
                if start <= str(i.get("invoice_date") or i.get("created_at") or "")[:10] <= end]
    counted = [i for i in invoices if i.get("status") in ("checked", "confirmed")]
    pending = [i for i in invoices if i.get("status") not in ("checked", "confirmed")]
    expenses = [e for e in _expenses(pk, start, end) if not e.get("skipped")]

    income = round(sum(s["total"] for s in paid), 2)
    purchases = round(sum(i.get("total") or 0 for i in counted), 2)
    spent = round(sum(e["amount"] for e in expenses), 2)
    by_category = {}
    for e in expenses:
        by_category[e["category"]] = round(by_category.get(e["category"], 0) + e["amount"], 2)
    by_payment = {k: round(sum(s["total"] for s in paid if s["payment"] == k), 2) for k in PAYMENTS}

    products = {}
    for s in paid:
        share = (s["total"] / s["subtotal"]) if s.get("subtotal") else 1  # spread a discount over the lines
        for line in s["lines"]:
            p = products.setdefault((line["kind"], line.get("key") or line["name"]),
                                    {"name": line["name"], "qty": 0, "revenue": 0.0, "cost": 0.0, "cost_known": True})
            p["qty"] += line["qty"]
            p["revenue"] += line["total"] * share
            if line.get("unit_cost") is None:
                p["cost_known"] = False
            else:
                p["cost"] += line["unit_cost"] * line["qty"]
    by_product = sorted(({"name": p["name"], "qty": round(p["qty"], 3), "revenue": round(p["revenue"], 2),
                          "cost": round(p["cost"], 2) if p["cost_known"] else None,
                          "profit": round(p["revenue"] - p["cost"], 2) if p["cost_known"] else None,
                          "margin_pct": round((p["revenue"] - p["cost"]) / p["revenue"] * 100, 1)
                          if p["cost_known"] and p["revenue"] else None} for p in products.values()),
                        key=lambda p: -p["revenue"])

    journal = [{"date": s["date"], "kind": "sale", "doc": f"Чек № {s['number']}", "party": PAYMENTS[s["payment"]],
                "amount": s["total"]} for s in paid]
    journal += [{"date": s["date"], "kind": "refund", "doc": f"Возврат по чеку № {s['number']}", "party": s.get("refund_reason") or "",
                 "amount": -s["total"]} for s in refunded]
    journal += [{"date": str(i.get("invoice_date") or i.get("created_at"))[:10], "kind": "purchase",
                 "doc": f"Накладная № {i.get('invoice_number') or 'без номера'}", "party": i.get("supplier_name") or "",
                 "amount": -(i.get("total") or 0)} for i in counted]
    journal += [{"date": e["date"], "kind": "expense", "doc": EXPENSE_CATEGORIES[e["category"]], "party": e.get("note") or "",
                 "amount": -e["amount"]} for e in expenses]
    journal.sort(key=lambda r: (r["date"], r["kind"]))

    rate = profile.get("tax_rate_pct")
    checks = []
    if rate is None:
        checks.append("Ставка налога не указана: задайте её в «Налоги» по своему режиму.")
    if not profile.get("bin"):
        checks.append("Не указан ИИН/БИН: он нужен в декларации и на чеке.")
    if pending:
        checks.append(f"Накладных без проверки за период: {len(pending)}. Они не вошли в расходы.")
    if end >= date.today().isoformat():
        checks.append("Период ещё не закончился: цифры изменятся.")
    if not paid:
        checks.append("Нет продаж за период. Если продажи шли через другую кассу, внесите их.")
    tax = {"regime": profile.get("tax_regime") or None, "rate_pct": rate, "base": income,
           "amount": round(income * rate / 100, 2) if rate is not None else None, "checks": checks,
           "note": "Черновик: налог считается как доход за период × ставка, которую вы указали. "
                   "Проверьте режим, ставку и вычеты с бухгалтером. Приложение ничего не отправляет в налоговую."}
    return {"period": label, "from": start, "to": end,
            "business": {"name": profile.get("business_name"), "bin": profile.get("bin"), "address": profile.get("address")},
            "income": income, "refunds": round(sum(s["total"] for s in refunded), 2), "receipts": len(paid),
            "by_payment": by_payment, "purchases": purchases, "expenses": spent, "by_category": by_category,
            "categories": EXPENSE_CATEGORIES, "profit": round(income - purchases - spent, 2),
            "by_product": by_product, "journal": journal, "tax": tax, "pending_invoices": len(pending)}


def get_report(user, params, body):
    pk, profile = _business(user)
    return build_report(pk, params.get("period") or date.today().isoformat()[:7])


# ---------- tax settings and calendar ----------

def _next_due(due, repeat, today):
    d = date.fromisoformat(due)
    step = {"monthly": 1, "quarterly": 3, "semiannual": 6, "yearly": 12}.get(repeat)
    while step and d < today:
        m = d.month - 1 + step
        y = d.year + m // 12
        m = m % 12 + 1
        d = date(y, m, min(date.fromisoformat(due).day, calendar.monthrange(y, m)[1]))
    return d


def get_taxes(user, params, body):
    pk, profile = _business(user)
    today = date.today()
    rows = []
    for t in db.store().query_prefix(pk, "TAXD#"):
        nxt = _next_due(t["due"], t["repeat"], today)
        rows.append({**_strip(t), "next_due": nxt.isoformat(), "days_left": (nxt - today).days,
                     "done": t["repeat"] == "none" and nxt < today})
    rows.sort(key=lambda r: (r["done"], r["next_due"]))
    return {"regime": profile.get("tax_regime"), "rate_pct": profile.get("tax_rate_pct"), "bin": profile.get("bin"),
            "address": profile.get("address"), "deadlines": rows, "templates": TAX_TEMPLATES, "repeats": REPEATS}


def put_taxes(user, params, body):
    pk, profile = _business(user)
    store = db.store()
    settings = store.get(pk, "SETTINGS") or {"PK": pk, "SK": "SETTINGS"}
    if "regime" in body:
        settings["tax_regime"] = str(body.get("regime") or "").strip()[:80] or None
    if "rate_pct" in body:
        rate = num(body.get("rate_pct"), "rate_pct", required=False)
        if rate is not None and not 0 <= rate <= 50:
            raise ApiError(400, "Ставка от 0 до 50%")
        settings["tax_rate_pct"] = rate
    if "bin" in body:
        bin_ = re.sub(r"\s", "", str(body.get("bin") or ""))
        if bin_ and not re.fullmatch(r"\d{12}", bin_):
            raise ApiError(400, "ИИН/БИН: 12 цифр")
        settings["bin"] = bin_ or None
    if "address" in body:
        settings["address"] = str(body.get("address") or "").strip()[:120] or None
    store.put(settings)
    return get_taxes(user, params, {})


def create_deadline(user, params, body):
    pk, profile = _business(user)
    title = str(body.get("title") or "").strip()
    if not 1 <= len(title) <= 100:
        raise ApiError(400, "Название: от 1 до 100 символов")
    repeat = body.get("repeat") or "none"
    if repeat not in REPEATS:
        raise ApiError(400, "Неизвестный повтор")
    try:
        due = date.fromisoformat(str(body.get("due") or "")).isoformat()
    except ValueError:
        raise ApiError(400, "Укажите дату срока")
    if len(db.store().query_prefix(pk, "TAXD#")) >= 30:
        raise ApiError(409, "Не больше 30 сроков")
    deadline_id = uuid.uuid4().hex[:10]
    item = {"PK": pk, "SK": f"TAXD#{deadline_id}", "deadline_id": deadline_id, "title": title, "due": due,
            "repeat": repeat, "created_at": now_iso()}
    db.store().put(item)
    return _strip(item)


def delete_deadline(user, params, body):
    pk, profile = _business(user)
    deadline_id = params.get("id") or ""
    if not EXP_ID_RE.fullmatch(deadline_id):
        raise ApiError(400, "Некорректный идентификатор")
    db.store().delete(pk, f"TAXD#{deadline_id}")
    return {"deleted": deadline_id}


def upcoming_deadlines(pk, days=14):
    today = date.today()
    out = []
    for t in db.store().query_prefix(pk, "TAXD#"):
        nxt = _next_due(t["due"], t["repeat"], today)
        if today <= nxt <= today + timedelta(days=days):
            out.append({"title": t["title"], "next_due": nxt.isoformat(), "days_left": (nxt - today).days})
    return sorted(out, key=lambda r: r["next_due"])


# ---------- accountant access (read only) ----------

def _email_pk(email):
    return f"EMAIL#{email}"


def list_access(user, params, body):
    pk, profile = _business(user)
    return {"accountants": [_strip(a) for a in db.store().query_prefix(pk, "ACCESS#")], "limit": ACCESS_LIMIT}


def grant_access(user, params, body):
    pk, profile = _business(user)
    email = str(body.get("email") or "").strip().lower()
    if not EMAIL_RE.match(email) or len(email) > 120:
        raise ApiError(400, "Некорректный email")
    if email == (user.get("email") or "").lower():
        raise ApiError(400, "Это ваш собственный email")
    store = db.store()
    current = store.query_prefix(pk, "ACCESS#")
    if len(current) >= ACCESS_LIMIT and not any(a["email"] == email for a in current):
        raise ApiError(409, f"Не больше {ACCESS_LIMIT} бухгалтеров")
    created = now_iso()
    store.put({"PK": pk, "SK": f"ACCESS#{email}", "email": email, "role": "accountant", "created_at": created})
    store.put({"PK": _email_pk(email), "SK": f"OWNER#{user['id']}", "owner_id": user["id"], "email": email,
               "owner_name": profile.get("business_name") or user.get("email"), "created_at": created})
    return {"email": email, "role": "accountant", "created_at": created}


def revoke_access(user, params, body):
    pk, profile = _business(user)
    email = str(params.get("email") or "").strip().lower()
    if not EMAIL_RE.match(email):
        raise ApiError(400, "Некорректный email")
    db.store().delete(pk, f"ACCESS#{email}")
    db.store().delete(_email_pk(email), f"OWNER#{user['id']}")
    return {"revoked": email}


def _verified_email(user):
    if not user.get("email_verified") or not user.get("email"):
        raise ApiError(403, "Подтвердите email аккаунта, чтобы видеть открытые вам отчёты")
    return user["email"].lower()


def list_shared(user, params, body):
    """Businesses whose reports this account may read (as their accountant)."""
    email = user.get("email") if user.get("email_verified") else None
    if not email:
        return {"owners": []}
    rows = db.store().query_prefix(_email_pk(email.lower()), "OWNER#")
    return {"owners": [{"owner_id": r["owner_id"], "name": r.get("owner_name"), "since": r.get("created_at")} for r in rows]}


def shared_report(user, params, body):
    email = _verified_email(user)
    owner = params.get("owner") or ""
    if not SUB_RE.fullmatch(owner):
        raise ApiError(400, "Некорректный идентификатор")
    store = db.store()
    grant = store.get(db.user_pk(owner), f"ACCESS#{email}")
    if not grant or not store.get(_email_pk(email), f"OWNER#{owner}"):
        raise ApiError(403, "Владелец не открывал вам доступ")
    return {**build_report(db.user_pk(owner), params.get("period") or date.today().isoformat()[:7]), "read_only": True}


# ---------- sample sales and expenses for the demo account ----------

DEMO_SALE_DAYS = (6, 5, 4, 3, 2, 1, 0)


def seed_demo_ledger(pk):
    """A week of sales of the demo products and a few expenses, flagged demo so clear_demo removes them."""
    store = db.store()
    products = {p["product_key"]: p for p in store.query_prefix(pk, "PROD#") if str(p["product_key"]).startswith("demo-")}
    if not products:
        return
    prices = {"demo-milk": 650, "demo-cream": 2400}
    number = 0
    for days_ago in DEMO_SALE_DAYS:
        when = date.today() - timedelta(days=days_ago)
        for n, (key, qty) in enumerate((("demo-milk", 6 + days_ago % 3), ("demo-cream", 2 + days_ago % 2))):
            if key not in products:
                continue
            number += 1
            sale_id = when.strftime("%Y%m%d") + f"1{n}0000-d3d3{number:02d}"
            price = prices[key]
            line = {"kind": "product", "key": key, "name": products[key]["name"], "unit": products[key].get("unit"),
                    "qty": qty, "price": price, "total": qty * price, "unit_cost": products[key].get("last_price")}
            store.put({"PK": pk, "SK": f"SALE#{sale_id}", "sale_id": sale_id, "number": number, "lines": [line],
                       "subtotal": line["total"], "discount": 0, "total": line["total"],
                       "payment": "card" if n else "cash", "status": "paid", "refund_reason": None,
                       "created_at": f"{when.isoformat()}T1{n}:00:00Z", "date": when.isoformat(), "demo": True})
    seq = store.get(pk, "SEQ#sale") or {"PK": pk, "SK": "SEQ#sale", "value": 0}
    store.put({**seq, "value": max(int(seq.get("value") or 0), number)})
    for key in products:
        store.put({"PK": pk, "SK": f"STOCK#{key}", "product_key": key, "sale_price": prices.get(key),
                   "min_qty": {"demo-cream": 40, "demo-milk": 20, "demo-flour": 1}.get(key), "demo": True})
    for days_ago, category, amount, note in ((10, "rent", 180000, "Аренда зала (демо)"), (3, "utilities", 24000, "Свет и вода (демо)")):
        day = (date.today() - timedelta(days=days_ago)).isoformat()
        store.put({"PK": pk, "SK": f"EXP#{day}#d3d3d3{days_ago:04d}", "expense_id": f"d3d3d3{days_ago:04d}",
                   "category": category, "amount": amount, "date": day, "note": note, "demo": True, "created_at": now_iso()})


DEMO_PREFIXES = ("SALE#", "EXP#", "STOCK#")


ROUTES = {
    "GET /sales": list_sales,
    "POST /sales": create_sale,
    "GET /sales/{id}": get_sale,
    "PUT /sales/{id}": refund_sale,
    "GET /expenses": list_expenses,
    "POST /expenses": create_expense,
    "DELETE /expenses/{id}": delete_expense,
    "GET /stock": list_stock,
    "PUT /stock/{key}": put_stock,
    "GET /reports": get_report,
    "GET /taxes": get_taxes,
    "PUT /taxes": put_taxes,
    "POST /taxes/deadlines": create_deadline,
    "DELETE /taxes/deadlines/{id}": delete_deadline,
    "GET /access": list_access,
    "POST /access": grant_access,
    "DELETE /access/{email}": revoke_access,
    "GET /shared": list_shared,
    "GET /shared/{owner}/reports": shared_report,
}
