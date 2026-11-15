#!/usr/bin/env python3
"""Monthly AWS cost estimate for SupplyRadar at a given number of active businesses.

    python3 scripts/cost_model.py                 # 100 and 10 000 users, Markdown tables
    python3 scripts/cost_model.py --users 500

An estimate, not a quote. Prices are list prices for eu-central-1 as known in
November 2026 and are kept in PRICES below so they are easy to check against
https://calculator.aws and to change. Only the "always free" allowances are
subtracted; the 12-month and credit-based offers of new accounts are ignored,
so a new account pays less than this.
"""
import argparse

HOURS, SECONDS = 730, 730 * 3600

PRICES = {
    "lambda_request": 0.20 / 1e6,            # per request
    "lambda_gb_s": 0.0000133334,             # arm64
    "apigw_request": 1.20 / 1e6,             # HTTP API
    "ddb_write": 0.7625 / 1e6,               # on-demand write request unit
    "ddb_read": 0.1525 / 1e6,                # on-demand read request unit
    "ddb_gb": 0.306,                         # storage, per GB-month
    "ddb_pitr_gb": 0.2448,                   # continuous backups, per GB-month
    "s3_gb": 0.0245,                         # Standard
    "s3_ia_gb": 0.0135,                      # Standard-IA
    "s3_put": 0.0054 / 1e3,
    "s3_get": 0.00043 / 1e3,
    "sqs_request": 0.40 / 1e6,
    "sns_email": 2.00 / 1e5,
    "cf_gb": 0.085,
    "cf_request": 0.012 / 1e4,               # HTTPS
    "logs_gb": 0.63,                         # ingestion
    "cognito_mau": 0.015,                    # Essentials tier
    "xray_trace": 5.00 / 1e6,
    "waf_acl": 5.00, "waf_rule": 1.00, "waf_request": 0.60 / 1e6,
    "kms_key": 1.00, "kms_request": 0.03 / 1e4,
    "alarm": 0.10,
    # Gemini Flash-Lite paid tier: ASSUMPTION, check https://ai.google.dev/gemini-api/docs/pricing
    "gemini_in": 0.10 / 1e6, "gemini_out": 0.40 / 1e6,
}

FREE = {  # always-free monthly allowances
    "lambda_request": 1e6, "lambda_gb_s": 400_000, "ddb_gb": 25, "sqs_request": 1e6,
    "sns_email": 1_000, "cf_gb": 1_000, "cf_request": 10e6, "logs_gb": 5,
    "cognito_mau": 10_000, "xray_trace": 100_000, "kms_request": 20_000, "alarm": 10,
}

USAGE = {  # per active business, per month
    "invoices": 100,              # 3-4 supplier invoices a day
    "api_calls_per_invoice": 12,  # upload, polling every 2 s, opening the result
    "browse_api_calls": 400,      # lists, products, alerts, savings, settings
    "visits": 40,                 # page loads of the web app
    "photo_mb": 0.4,              # resized in the browser to <= 2000 px JPEG
    "lines_per_invoice": 8,
    "alerts_per_invoice": 0.1,
    "assistant_questions": 20,    # Pro plan only; counted for everyone to stay on the safe side
}


def over(key, amount):
    """Cost of `amount` units after the always-free allowance."""
    return max(0.0, amount - FREE.get(key, 0)) * PRICES[key]


def estimate(users, waf=False, kms=False, environments=1):
    u = USAGE
    invoices = users * u["invoices"]
    api_calls = invoices * u["api_calls_per_invoice"] + users * (u["browse_api_calls"] + u["assistant_questions"])
    alerts = invoices * u["alerts_per_invoice"]
    digests = users * 4.3

    # Lambda: invocations and GB-seconds per function (memory GB x average seconds).
    inv = {"api": api_calls, "extract": invoices, "validate": invoices * 1.1, "notify": alerts, "digest": 4.3}
    gb_s = (api_calls * 0.256 * 0.12 + invoices * 0.512 * 4.0 + invoices * 1.1 * 0.256 * 0.3
            + alerts * 0.256 * 0.2 + 4.3 * 0.256 * (5 + users * 0.05)
            + users * u["assistant_questions"] * 0.256 * 3.0)
    lambda_inv = sum(inv.values())

    # DynamoDB: writes per invoice = record + 2 status updates + 3 items per line + alert.
    writes = invoices * (3 + 3 * u["lines_per_invoice"] + u["alerts_per_invoice"]) + users * 30
    reads = api_calls * 3 + invoices * (2 + 2 * u["lines_per_invoice"])
    table_gb = users * u["invoices"] * 12 * (2 + 0.6 * u["lines_per_invoice"]) / 1e6  # a year of history
    on_demand = writes / SECONDS > 1.0  # average above 1 write/s: 5 provisioned WCU no longer absorb the peaks

    # S3: 30 days in Standard, then Standard-IA until day 90.
    month_gb = invoices * u["photo_mb"] / 1024

    # SQS: real messages plus the idle long polling of the two Lambda pollers
    # (about 15 empty receives a minute per queue, around the clock).
    sqs = invoices * 2 * 3 + 2 * 15 * 60 * HOURS * environments

    cf_requests = users * u["visits"] * 12
    cf_gb = users * u["visits"] * 0.15 / 1024  # ~150 KB per visit after compression and caching

    logs_gb = (lambda_inv * 450 + api_calls * 300) / 1e9
    traces = min(lambda_inv, 0.05 * lambda_inv + SECONDS)  # X-Ray default: 1 trace/s + 5 %

    gemini_calls = invoices + digests + users * u["assistant_questions"]

    rows = [
        ("Lambda (5 functions, arm64)", f"{lambda_inv / 1e6:.2f} M invocations, {gb_s / 1e3:.0f} k GB-s",
         over("lambda_request", lambda_inv) + over("lambda_gb_s", gb_s)),
        ("API Gateway HTTP API", f"{api_calls / 1e6:.2f} M requests", api_calls * PRICES["apigw_request"]),
        ("DynamoDB " + ("on-demand" if on_demand else "provisioned 5/5 (free tier)"),
         f"{writes / 1e6:.2f} M writes, {reads / 1e6:.2f} M reads, {table_gb:.1f} GB",
         (writes * PRICES["ddb_write"] + reads * PRICES["ddb_read"] if on_demand else 0.0) + over("ddb_gb", table_gb)),
        ("DynamoDB point-in-time recovery", f"{table_gb:.1f} GB", table_gb * PRICES["ddb_pitr_gb"]),
        ("S3 uploads (30 d Standard, 60 d Standard-IA)", f"{month_gb * 3:.1f} GB stored, {invoices / 1e3:.0f} k uploads",
         month_gb * PRICES["s3_gb"] + 2 * month_gb * PRICES["s3_ia_gb"]
         + invoices * PRICES["s3_put"] + invoices * 3 * PRICES["s3_get"]),
        ("CloudFront + web bucket", f"{cf_gb:.1f} GB, {cf_requests / 1e6:.2f} M requests",
         over("cf_gb", cf_gb) + over("cf_request", cf_requests)),
        ("SQS (2 queues + 2 DLQs)", f"{sqs / 1e6:.2f} M requests (mostly idle polling)", over("sqs_request", sqs)),
        ("SNS email", f"{alerts + digests:.0f} emails", over("sns_email", alerts + digests)),
        ("Cognito", f"{users} monthly active users", over("cognito_mau", users)),
        ("CloudWatch logs, 10 alarms, dashboard", f"{logs_gb:.1f} GB logs",
         over("logs_gb", logs_gb) + over("alarm", 10 * environments)),
        ("X-Ray", f"{traces / 1e3:.0f} k traces", over("xray_trace", traces)),
        ("VPC, SSM, Scheduler, Budgets, IAM", "no NAT, gateway endpoints only", 0.0),
    ]
    if waf:
        rows.append(("WAF (optional)", f"web ACL + 4 rules, {cf_requests / 1e6:.2f} M requests",
                     PRICES["waf_acl"] + 4 * PRICES["waf_rule"] + cf_requests * PRICES["waf_request"]))
    if kms:
        kms_requests = invoices * 0.5 + 60_000  # bucket key and 1-hour data key reuse keep this low
        rows.append(("KMS key (optional)", f"1 key, {kms_requests / 1e3:.0f} k requests",
                     PRICES["kms_key"] + over("kms_request", kms_requests)))
    aws_total = sum(r[2] for r in rows)
    gemini = gemini_calls * (1_800 * PRICES["gemini_in"] + 600 * PRICES["gemini_out"])
    rows.append(("**AWS total**", "", aws_total))
    rows.append(("Gemini API, paid tier (assumed price)", f"{gemini_calls / 1e3:.0f} k calls", gemini))
    rows.append(("**Total with paid Gemini**", "", aws_total + gemini))
    return rows, invoices


def money(x):
    return "$0" if x < 0.005 else f"${x:,.2f}"


def table(users, **kw):
    rows, invoices = estimate(users, **kw)
    out = ["| Service | Usage per month | Cost |", "|---|---|---:|"]
    out += [f"| {name} | {usage} | {money(cost)} |" for name, usage, cost in rows]
    total = rows[-1][2]
    out.append(f"\nPer business: {money(total / users)} a month; per invoice: ${total / invoices:.4f}.")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--users", type=int, nargs="*", default=[100, 10_000])
    args = ap.parse_args()
    for users in args.users:
        print(f"### {users:,} active businesses\n")
        print(table(users))
        base = estimate(users)[0][-1][2]
        extras = estimate(users, waf=True, kms=True)[0][-1][2] - base
        print(f"\nWith WAF and the customer-managed KMS key switched on: + {money(extras)} a month.\n")


if __name__ == "__main__":
    main()
