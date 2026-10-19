"""Validate Lambda (runs inside the VPC, reaches DynamoDB through a gateway endpoint).

Input: messages from the validate queue, sent by the extract function or by the
API when a user confirms a reviewed invoice:
    {"user_id", "invoice_id", "extraction": {...}, "confirmed": bool}

Runs the five checks, stores the invoice as checked / needs_review / confirmed,
and for trusted invoices records prices and raises alerts.
"""
import json
import logging
from datetime import datetime, timezone

from supplyradar import checks, config, db, pricing, products

log = logging.getLogger()
log.setLevel(logging.INFO)

TRUSTED = ("checked", "confirmed")


def handler(event, context):
    failures = []
    for record in event.get("Records", []):
        try:
            process(json.loads(record["body"]))
        except Exception:
            log.exception("validate failed for message %s", record.get("messageId"))
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def process(msg):
    store = db.store()
    user_id, invoice_id = msg["user_id"], msg["invoice_id"]
    pk = db.user_pk(user_id)
    current = store.get(pk, f"INV#{invoice_id}")
    if current is None:
        log.warning("invoice %s not found, skipping", invoice_id)
        return
    confirmed = bool(msg.get("confirmed"))
    if current.get("status") in TRUSTED and not confirmed:
        log.info("invoice %s already %s, skipping duplicate delivery", invoice_id, current["status"])
        return

    inv = checks.clean_invoice(msg["extraction"])
    bin_ok = checks.bin_is_valid(inv["supplier_bin"])
    skey = products.supplier_key(inv["supplier_bin"], inv["supplier_name"], bin_ok)

    duplicate_of = None
    if inv["invoice_number"]:
        dup = store.get(pk, f"DUP#{skey}#{inv['invoice_number']}")
        if dup and dup["invoice_id"] != invoice_id:
            duplicate_of = dup["invoice_id"]

    issues = checks.run_checks(inv, duplicate_of=duplicate_of)
    if confirmed:
        status = "confirmed"
    else:
        status = "needs_review" if issues else "checked"

    for line in inv["lines"]:
        line["product_key"] = resolve_product(store, pk, line)

    updated = {
        **current,
        **inv,
        "supplier_key": skey,
        "status": status,
        "issues": issues,
        "duplicate_of": duplicate_of,
        "updated_at": now_iso(),
    }
    store.put(updated)
    log.info("invoice %s -> %s (%d issues)", invoice_id, status, len(issues))

    if status in TRUSTED:
        if inv["invoice_number"]:
            try:
                store.put({"PK": pk, "SK": f"DUP#{skey}#{inv['invoice_number']}",
                           "invoice_id": invoice_id}, if_absent=True)
            except db.AlreadyExists:
                pass
        record_prices(store, pk, updated)


def resolve_product(store, pk, line):
    """Known printed names reuse their product key; new ones are remembered."""
    alias_sk = f"ALIAS#{products.normalize(line['name'])[:200]}"
    alias = store.get(pk, alias_sk)
    if alias:
        return alias["product_key"]
    key = products.product_key(line["canonical_name"] or line["name"])
    try:
        store.put({"PK": pk, "SK": alias_sk, "product_key": key, "name": line["name"]}, if_absent=True)
    except db.AlreadyExists:
        pass
    return key


def threshold_for(store, pk):
    settings = store.get(pk, "SETTINGS") or {}
    return float(settings.get("threshold_pct") or config.DEFAULT_THRESHOLD_PCT)


def record_prices(store, pk, inv):
    threshold = threshold_for(store, pk)
    inv_date = inv.get("invoice_date") or inv["created_at"][:10]
    for n, line in enumerate(inv["lines"]):
        price = line.get("price")
        if not price or price <= 0:
            continue
        key = line["product_key"]
        store.put({
            "PK": pk,
            "SK": f"PRICE#{key}#{inv_date}#{inv['invoice_id']}#{n}",
            "product_key": key,
            "date": inv_date,
            "price": price,
            "quantity": line.get("quantity"),
            "unit": line.get("unit"),
            "supplier": inv.get("supplier_name"),
            "supplier_key": inv["supplier_key"],
            "invoice_id": inv["invoice_id"],
        })

        product = store.get(pk, f"PROD#{key}")
        suppliers, alert = pricing.evaluate_price(
            product, inv["supplier_key"], inv.get("supplier_name"), price,
            inv_date, inv["invoice_id"], threshold,
        )
        latest = max(suppliers.values(), key=lambda e: e.get("date", ""), default=None)
        store.put({
            "PK": pk,
            "SK": f"PROD#{key}",
            "product_key": key,
            "name": line.get("canonical_name") or line.get("name"),
            "unit": line.get("unit"),
            "suppliers": suppliers,
            "last_price": latest["price"] if latest else price,
            "last_date": latest["date"] if latest else inv_date,
            "updated_at": now_iso(),
        })

        if alert:
            try:
                store.put({
                    "PK": pk,
                    "SK": f"ALERT#{inv['created_at']}#{inv['invoice_id']}#{key}",
                    "user_id": inv["user_id"],
                    "product_key": key,
                    "product": line.get("canonical_name") or line.get("name"),
                    "quantity": line.get("quantity"),
                    "invoice_id": inv["invoice_id"],
                    "invoice_date": inv_date,
                    "created_at": now_iso(),
                    **alert,
                }, if_absent=True)
            except db.AlreadyExists:
                pass
