"""Notify Lambda: DynamoDB Streams (new ALERT# items only, filtered by the
event source mapping) -> one email per alert through SNS.

The SNS topic has one email subscription per user with a filter policy on the
user_id message attribute, so each owner gets only their own alerts.
"""
import logging

from boto3.dynamodb.types import TypeDeserializer

from supplyradar import aws, config, db

log = logging.getLogger()
log.setLevel(logging.INFO)
_deser = TypeDeserializer()


def handler(event, context):
    failures = []
    for record in event.get("Records", []):
        try:
            image = record["dynamodb"].get("NewImage")
            if not image:
                continue
            alert = db.from_db({k: _deser.deserialize(v) for k, v in image.items()})
            if not alert["SK"].startswith("ALERT#"):
                continue
            subject, message = format_alert(alert)
            aws.client("sns").publish(
                TopicArn=config.ALERTS_TOPIC_ARN,
                Subject=subject,
                Message=message,
                MessageAttributes={"user_id": {"DataType": "String", "StringValue": alert["user_id"]}},
            )
            log.info("alert sent for %s", alert["SK"])
        except Exception:
            log.exception("notify failed")
            failures.append({"itemIdentifier": record["dynamodb"]["SequenceNumber"]})
    return {"batchItemFailures": failures}


def money(value):
    return f"{value:,.0f}".replace(",", " ") + " ₸"


def format_alert(a):
    subject = f"SupplyRadar: {a['product']} +{a['change_pct']:g}%"[:99]
    lines = [
        f"Цена выросла: {a['product']}",
        f"Поставщик: {a.get('supplier') or '—'}",
        f"Было: {money(a['old_price'])}  →  стало: {money(a['new_price'])} (+{a['change_pct']:g}%)",
        f"Накладная от {a.get('invoice_date', '')}",
    ]
    if a.get("quantity"):
        extra = (a["new_price"] - a["old_price"]) * a["quantity"]
        lines.append(f"Переплата по этой накладной: {money(extra)}")
    if a.get("cheaper_supplier"):
        lines.append(
            f"У поставщика {a['cheaper_supplier']} дешевле: {money(a['cheaper_price'])} "
            f"(на {a['cheaper_pct']:g}% меньше)"
        )
    if config.APP_URL:
        lines += ["", f"Открыть историю цен: {config.APP_URL}/#/products/{a['product_key']}"]
    return subject, "\n".join(lines)
