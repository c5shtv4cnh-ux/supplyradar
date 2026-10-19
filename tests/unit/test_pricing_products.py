from supplyradar import pricing, products


def test_normalize_and_key():
    assert products.normalize("  МОЛОКО 3,2  1Л ") == "молоко 3.2 1л"
    assert products.product_key("Молоко 3.2% 1 л") == "молоко-3.2pct-1-л"
    assert products.product_key("Сливки «Простоквашино» 33%") == "сливки-простоквашино-33pct"
    assert products.product_key("###") == "unknown"


def test_supplier_key_prefers_valid_bin():
    assert products.supplier_key("990140000017", "ТОО А", True) == "990140000017"
    assert products.supplier_key("123", "ТОО «Свежая ферма»", False) == "тоо-свежая-ферма"


def first(price=1500.0, date="2026-09-20", inv="inv1", supplier="A"):
    suppliers, alert = pricing.evaluate_price(None, supplier, f"Supplier {supplier}", price, date, inv, 5)
    return {"suppliers": suppliers}, alert


def test_first_price_never_alerts():
    product, alert = first()
    assert alert is None
    assert product["suppliers"]["A"]["price"] == 1500.0


def test_increase_above_threshold_alerts():
    product, _ = first()
    suppliers, alert = pricing.evaluate_price(product, "A", "Supplier A", 1680.0, "2026-10-12", "inv2", 5)
    assert alert == {"supplier": "Supplier A", "old_price": 1500.0, "new_price": 1680.0, "change_pct": 12.0}
    assert suppliers["A"]["prev_price"] == 1500.0


def test_increase_below_threshold_is_quiet():
    product, _ = first()
    _, alert = pricing.evaluate_price(product, "A", "Supplier A", 1530.0, "2026-10-12", "inv2", 5)
    assert alert is None


def test_cheaper_supplier_is_suggested():
    product, _ = first()
    product["suppliers"]["B"] = {"name": "Supplier B", "price": 1545.0, "date": "2026-10-01", "invoice_id": "x"}
    _, alert = pricing.evaluate_price(product, "A", "Supplier A", 1680.0, "2026-10-12", "inv2", 5)
    assert alert["cheaper_supplier"] == "Supplier B"
    assert alert["cheaper_pct"] == 8.0


def test_reprocessing_same_invoice_gives_same_alert():
    product, _ = first()
    suppliers, alert1 = pricing.evaluate_price(product, "A", "Supplier A", 1680.0, "2026-10-12", "inv2", 5)
    _, alert2 = pricing.evaluate_price({"suppliers": suppliers}, "A", "Supplier A", 1680.0, "2026-10-12", "inv2", 5)
    assert alert1 == alert2


def test_older_invoice_does_not_replace_latest():
    product, _ = first(date="2026-10-12")
    suppliers, alert = pricing.evaluate_price(product, "A", "Supplier A", 1300.0, "2026-09-01", "old", 5)
    assert alert is None
    assert suppliers["A"]["price"] == 1500.0
