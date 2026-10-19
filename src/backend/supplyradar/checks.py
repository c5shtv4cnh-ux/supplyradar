"""The five checks code runs on every extracted invoice.

AI reads the document; these checks decide whether its numbers can be trusted.
An invoice with any issue goes to human review instead of the price history.
"""
import re
from datetime import date, timedelta

BIN_WEIGHTS_1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
BIN_WEIGHTS_2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2]
MAX_AGE_DAYS = 365


def bin_is_valid(value):
    """Kazakhstan BIN/IIN: 12 digits, the last one is a mod-11 check digit."""
    if not value or not re.fullmatch(r"\d{12}", str(value)):
        return False
    digits = [int(c) for c in str(value)]
    check = sum(d * w for d, w in zip(digits, BIN_WEIGHTS_1)) % 11
    if check == 10:
        check = sum(d * w for d, w in zip(digits, BIN_WEIGHTS_2)) % 11
        if check == 10:
            return False
    return check == digits[11]


def parse_date(value):
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace(" ", "").replace(",", "."))
    except (TypeError, ValueError):
        return None


def clean_invoice(raw):
    """Coerce model output into the shape the checks expect (numbers as floats)."""
    lines = []
    for line in raw.get("lines") or []:
        lines.append({
            "name": (line.get("name") or "").strip(),
            "canonical_name": (line.get("canonical_name") or line.get("name") or "").strip(),
            "quantity": _number(line.get("quantity")),
            "unit": line.get("unit"),
            "price": _number(line.get("price")),
            "total": _number(line.get("total")),
        })
    supplier_bin = re.sub(r"\D", "", str(raw.get("supplier_bin") or "")) or None
    return {
        "supplier_name": (raw.get("supplier_name") or "").strip() or None,
        "supplier_bin": supplier_bin,
        "invoice_number": (str(raw.get("invoice_number") or "").strip()) or None,
        "invoice_date": raw.get("invoice_date"),
        "currency": raw.get("currency") or "KZT",
        "total": _number(raw.get("total")),
        "lines": lines,
    }


def _close(a, b, rel):
    return abs(a - b) <= max(1.0, rel * abs(b))


def run_checks(inv, today=None, duplicate_of=None):
    """Return a list of issues; an empty list means the invoice is checked."""
    today = today or date.today()
    issues = []

    def add(field, code, message):
        issues.append({"field": field, "code": code, "message": message})

    for field, label in (("supplier_name", "поставщик"), ("invoice_date", "дата"), ("total", "итог")):
        if inv.get(field) in (None, ""):
            add(field, "missing", f"Не распознано поле: {label}")
    if not inv.get("lines"):
        add("lines", "missing", "Не найдено ни одной строки товара")

    # 1. quantity x price = line total
    for i, line in enumerate(inv.get("lines") or []):
        qty, price, total = line["quantity"], line["price"], line["total"]
        if None in (qty, price, total):
            add(f"lines.{i}", "missing", f"Строка {i + 1}: не распознаны количество, цена или сумма")
        elif not _close(qty * price, total, 0.01):
            add(f"lines.{i}.total", "line_math",
                f"Строка {i + 1}: {qty:g} × {price:g} = {qty * price:g}, а в накладной {total:g}")

    # 2. sum of lines = invoice total
    totals = [l["total"] for l in inv.get("lines") or [] if l["total"] is not None]
    if inv.get("total") is not None and totals and not _close(sum(totals), inv["total"], 0.002):
        add("total", "sum_mismatch",
            f"Сумма строк {sum(totals):g} не равна итогу {inv['total']:g}")

    # 3. supplier BIN
    if not bin_is_valid(inv.get("supplier_bin")):
        add("supplier_bin", "bin_invalid", "БИН поставщика не прошёл проверку контрольной цифры")

    # 4. date is real, not in the future, not too old
    if inv.get("invoice_date"):
        parsed = parse_date(inv["invoice_date"])
        if parsed is None:
            add("invoice_date", "date_invalid", f"Некорректная дата: {inv['invoice_date']}")
        elif parsed > today + timedelta(days=1):
            add("invoice_date", "date_future", "Дата накладной в будущем")
        elif parsed < today - timedelta(days=MAX_AGE_DAYS):
            add("invoice_date", "date_old", "Накладная старше одного года")

    # 5. duplicate invoice number from the same supplier
    if duplicate_of:
        add("invoice_number", "duplicate", "Накладная с таким номером от этого поставщика уже загружена")

    return issues
