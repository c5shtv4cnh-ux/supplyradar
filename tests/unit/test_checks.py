from datetime import date

from supplyradar import checks

TODAY = date(2026, 10, 19)
VALID_BIN = "990140000017"  # passes the mod-11 check digit


def invoice(**overrides):
    inv = {
        "supplier_name": "ТОО Молочный двор",
        "supplier_bin": VALID_BIN,
        "invoice_number": "2417",
        "invoice_date": "2026-10-12",
        "currency": "KZT",
        "total": 3250.0,
        "lines": [
            {"name": "Молоко 3,2% 1 л", "canonical_name": "молоко 3.2% 1 л",
             "quantity": 2.0, "unit": "шт", "price": 420.0, "total": 840.0},
            {"name": "Сливки 33% 0,5 л", "canonical_name": "сливки 33% 0.5 л",
             "quantity": 1.0, "unit": "шт", "price": 1680.0, "total": 1680.0},
            {"name": "Творог 5%", "canonical_name": "творог 5%",
             "quantity": 1.0, "unit": "кг", "price": 730.0, "total": 730.0},
        ],
    }
    inv.update(overrides)
    return inv


def codes(issues):
    return sorted(i["code"] for i in issues)


def test_bin_checksum():
    assert checks.bin_is_valid(VALID_BIN)
    assert not checks.bin_is_valid("990140000016")
    assert not checks.bin_is_valid("12345")
    assert not checks.bin_is_valid(None)


def test_clean_invoice_coerces_numbers_and_bin():
    raw = {"supplier_bin": "БИН 9901 4000 0017", "total": "3 250,50",
           "lines": [{"name": "X", "quantity": "2", "price": "1,5", "total": 3}]}
    inv = checks.clean_invoice(raw)
    assert inv["supplier_bin"] == VALID_BIN
    assert inv["total"] == 3250.5
    assert inv["lines"][0]["price"] == 1.5
    assert inv["lines"][0]["canonical_name"] == "X"


def test_good_invoice_has_no_issues():
    assert checks.run_checks(invoice(), today=TODAY) == []


def test_line_math_flags_the_wrong_row():
    inv = invoice()
    inv["lines"][1]["total"] = 1860.0
    inv["total"] = 3430.0
    issues = checks.run_checks(inv, today=TODAY)
    assert codes(issues) == ["line_math"]
    assert issues[0]["field"] == "lines.1.total"


def test_sum_mismatch():
    assert codes(checks.run_checks(invoice(total=3500.0), today=TODAY)) == ["sum_mismatch"]


def test_small_rounding_is_tolerated():
    inv = invoice(total=3250.4)
    inv["lines"][0]["total"] = 840.4
    assert checks.run_checks(inv, today=TODAY) == []


def test_bad_bin_date_and_duplicate():
    issues = checks.run_checks(invoice(supplier_bin="123456789012", invoice_date="2027-01-01"),
                               today=TODAY, duplicate_of="older")
    assert codes(issues) == ["bin_invalid", "date_future", "duplicate"]


def test_old_and_unparseable_dates():
    assert codes(checks.run_checks(invoice(invoice_date="2024-01-01"), today=TODAY)) == ["date_old"]
    assert codes(checks.run_checks(invoice(invoice_date="12.10.2026"), today=TODAY)) == ["date_invalid"]


def test_missing_values():
    inv = invoice(total=None)
    inv["lines"][0]["price"] = None
    assert codes(checks.run_checks(inv, today=TODAY)) == ["missing", "missing"]
