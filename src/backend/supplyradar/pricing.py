"""Price comparison: decide whether a new price is an increase worth an alert."""


def evaluate_price(product, supplier_key, supplier_name, price, inv_date, invoice_id, threshold_pct):
    """Compare one invoice line with the product's latest prices.

    product: the PROD# item (or None), with suppliers = {supplier_key: entry}.
    Returns (suppliers, alert) where suppliers is the updated map to store and
    alert is a dict or None. Safe to call twice for the same invoice: the
    second call reproduces the same result instead of comparing with itself.
    """
    suppliers = dict((product or {}).get("suppliers") or {})
    entry = suppliers.get(supplier_key)

    if entry and entry.get("invoice_id") == invoice_id:
        prev = entry.get("prev_price")
    elif entry and inv_date < entry.get("date", ""):
        return suppliers, None  # an older invoice arrived late: keep it in history only
    else:
        prev = entry.get("price") if entry else None
        suppliers[supplier_key] = {
            "name": supplier_name,
            "price": price,
            "date": inv_date,
            "invoice_id": invoice_id,
            "prev_price": prev,
        }

    if not prev or prev <= 0 or price <= prev:
        return suppliers, None
    change_pct = round((price - prev) / prev * 100, 1)
    if change_pct < threshold_pct:
        return suppliers, None

    alert = {
        "supplier": supplier_name,
        "old_price": prev,
        "new_price": price,
        "change_pct": change_pct,
    }
    cheaper = [
        (e["price"], e.get("name") or k)
        for k, e in suppliers.items()
        if k != supplier_key and e.get("price") and e["price"] < price
    ]
    if cheaper:
        best_price, best_name = min(cheaper)
        alert["cheaper_supplier"] = best_name
        alert["cheaper_price"] = best_price
        alert["cheaper_pct"] = round((price - best_price) / price * 100, 1)
    return suppliers, alert
