"""Digest Lambda: weekly (EventBridge Scheduler) plain-language summary per user.

DynamoDB (last 7 days of alerts) -> Gemini writes the summary -> SNS email.
If the model is unavailable, a template summary is sent instead.
"""
import json
import logging
from datetime import datetime, timedelta, timezone

from supplyradar import aws, config, db, gemini

log = logging.getLogger()
log.setLevel(logging.INFO)

PROMPT = """Ты помощник владельца небольшого кафе или магазина. Ниже JSON с ростом цен
поставщиков за последнюю неделю. Напиши короткую сводку на русском (4-7 предложений):
где переплатили больше всего и на сколько тенге, какие товары подорожали сильнее всего,
где есть поставщик дешевле. Без markdown, без выдуманных цифр, только данные из JSON.

Данные:
{data}
"""


def handler(event, context):
    store = db.store()
    since = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    sent = 0
    for settings in store.scan_sk("SETTINGS"):
        if not settings.get("email"):
            continue
        user_id = settings["PK"].split("#", 1)[1]
        alerts = store.query_range(settings["PK"], f"ALERT#{since}", "ALERT#~")
        message = build_digest(alerts)
        aws.client("sns").publish(
            TopicArn=config.ALERTS_TOPIC_ARN,
            Subject="SupplyRadar: недельная сводка по ценам",
            Message=message,
            MessageAttributes={"user_id": {"DataType": "String", "StringValue": user_id}},
        )
        sent += 1
    log.info("digest sent to %d users", sent)
    return {"sent": sent}


def summarize(alerts):
    rows = []
    for a in alerts:
        overpaid = (a["new_price"] - a["old_price"]) * (a.get("quantity") or 1)
        rows.append({
            "product": a["product"], "supplier": a.get("supplier"),
            "old_price": a["old_price"], "new_price": a["new_price"],
            "change_pct": a["change_pct"], "overpaid_kzt": round(overpaid),
            "cheaper_supplier": a.get("cheaper_supplier"), "cheaper_price": a.get("cheaper_price"),
        })
    rows.sort(key=lambda r: r["overpaid_kzt"], reverse=True)
    return rows, sum(r["overpaid_kzt"] for r in rows)


def template_text(rows, total):
    lines = [f"За неделю найдено повышений цен: {len(rows)}. Переплата: {total:,.0f} ₸.".replace(",", " ")]
    for r in rows[:5]:
        line = f"- {r['product']} ({r['supplier']}): {r['old_price']:g} → {r['new_price']:g} ₸, +{r['change_pct']:g}%"
        if r.get("cheaper_supplier"):
            line += f"; дешевле у {r['cheaper_supplier']} ({r['cheaper_price']:g} ₸)"
        lines.append(line)
    return "\n".join(lines)


def build_digest(alerts):
    if not alerts:
        text = "За прошедшую неделю цены поставщиков не выросли выше вашего порога. Хорошая неделя!"
    else:
        rows, total = summarize(alerts)
        details = template_text(rows, total)
        try:
            text = gemini.write_text(PROMPT.format(data=json.dumps(rows, ensure_ascii=False)))
            text += "\n\nДетали:\n" + details
        except Exception:
            log.exception("Gemini summary failed, using template")
            text = details
    if config.APP_URL:
        text += f"\n\nОткрыть SupplyRadar: {config.APP_URL}"
    return text
