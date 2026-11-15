# Cost analysis and optimisation

**Expected cost at demo load: about $0 per month** (1 owner, ~200 invoices/month; the only item that
can leave the free tier is about $0.15 of idle SQS polling). This is an estimate, not a
guarantee: free allowances differ between AWS account plans and change over time. Check
<https://aws.amazon.com/free> and the pricing pages before the defence.

## Demo-load estimate

| Service | Assumed usage / month | Free allowance | Cost |
|---|---|---|---|
| Lambda (5 functions, arm64) | ~3 000 invocations, ~2 000 GB-s | 1 M requests + 400 000 GB-s | $0 |
| API Gateway HTTP API | ~2 000 requests (UI polls every 2 s while processing) | 1 M (12 months); then $1.00 / M | $0 |
| DynamoDB (provisioned 5 RCU / 5 WCU) | < 100 MB | 25 GB + 25 RCU / 25 WCU | $0 |
| DynamoDB Streams | ~1 000 read requests | 2.5 M stream reads | $0 |
| SQS (2 queues + 2 DLQs) | ~1.3 M requests: Lambda polls each work queue about 15 times a minute even when it is empty | 1 M requests | ~$0.15 |
| S3 (2 buckets) | < 200 MB, a few thousand requests | 5 GB, 20 000 GET, 2 000 PUT (12 months) | ~$0.01 |
| CloudFront | < 1 GB, < 50 000 requests | 1 TB, 10 M requests | $0 |
| Cognito | 1–5 users | 10 000 MAU | $0 |
| SNS email | < 300 emails | 1 000 emails | $0 |
| EventBridge Scheduler | 4 invocations | 14 M | $0 |
| CloudWatch | 6 log groups (7-day retention), 10 alarms, 3 metrics from logs, 1 dashboard | 5 GB logs, 10 alarms, 10 custom metrics, 3 dashboards | $0 |
| X-Ray | a few thousand traces | 100 000 traces | $0 |
| DynamoDB point-in-time recovery | < 100 MB | none ($0.24 per GB-month) | < $0.03 |
| SSM Parameter Store | 1 standard SecureString | standard tier free | $0 |
| VPC | 2 subnets, 2 gateway endpoints, no NAT | gateway endpoints are free | $0 |
| AWS Budgets | 1 budget | first 2 budgets free | $0 |
| **Gemini API** (Google) | ~200 invoices + 4 digests | free tier quota in AI Studio | $0 |

Paid fallback for Gemini if the free quota runs out: Flash-Lite input is priced per million tokens
(about $0.10–0.25 / M input tokens depending on the model version). One invoice photo resized to 2000 px is
roughly 1 000–1 500 input tokens, so 200 invoices cost well under $0.10.

## Design decisions that keep it at $0

| Decision | Saves | Trade-off |
|---|---|---|
| **No NAT gateway.** Only the validate function is in the VPC; it reaches DynamoDB/S3 through free gateway endpoints. The extract function calls Gemini from outside the VPC. | ~$32/month + data processing | Extract is not network-isolated (it has no access to the table except status updates, see IAM) |
| No interface endpoints (SQS, SNS, SSM) | ~$7–8/month each per AZ | Functions that need them run outside the VPC |
| DynamoDB provisioned 5/5 instead of on-demand | stays inside always-free capacity | needs a change if traffic grows |
| arm64 Lambda | ~20 % cheaper per GB-s once out of free tier | none for pure Python |
| Image resized in the browser (≤ 2000 px JPEG) | fewer S3 bytes and Gemini tokens | slightly slower upload on old phones |
| DynamoDB Streams event filter (`ALERT#` only) | notify function is not invoked on other writes | none |
| Extract concurrency capped at 2 | stays under Gemini free-tier rate limits | queue absorbs bursts instead |
| 7-day log retention, 90-day expiry on originals | CloudWatch and S3 storage | older originals not kept |
| HTTP API instead of REST API | ~70 % cheaper per request | fewer features (none needed) |
| WAF and the customer-managed KMS key are switches, off in dev | WAF about $9/month, KMS $1/month | dev relies on throttling, CSP and AWS-owned encryption keys; prod turns both on |
| Exactly 10 alarms (merged with metric math) | $0.10 per extra alarm | one alarm covers both dead-letter queues |
| No custom domain | Route 53 $0.50/month | default CloudFront domain |

## Cost controls

- **AWS Budgets:** $1/month in dev ($15 in prod, where the paid switches are on), email at 50 % actual and 100 % forecast (`modules/monitoring`).
- **Tags:** every resource has `Project`, `Environment`, `ManagedBy` (provider `default_tags`) for Cost Explorer.
- **Throttling:** API 10 requests/s, burst 20; 2 requests/s on the AI assistant route.
- **Storage lifecycle:** invoice originals move to Standard-IA after 30 days and are deleted after 90.
- **Tear down:** `terraform destroy` after the defence.

## Optional security features

| Switch | What you pay | When it is worth it |
|---|---|---|
| `enable_waf` | $5 web ACL + $4 for four rules + $0.60 per million requests, billed per hour (≈ $0.30 a day) | public launch, or one day for the defence demo |
| `enable_kms` | $1 per month + $0.03 per 10 000 requests (20 000 free) | when someone asks who can decrypt the data and wants an audit trail |
| second environment (prod) in the same account | alarms 11–20: $1; second set of idle SQS polling: ≈ $0.50 | while prod exists |

## Cost at 100 and 10 000 users

Produced by `python3 scripts/cost_model.py` (`make cost`). "User" means one active business that
uploads 100 invoices a month, opens the app 40 times and asks the assistant 20 questions.
All assumptions and unit prices are at the top of the script, so the estimate can be re-run with
other numbers.

How to read it:

- It is an **estimate**. Prices are eu-central-1 list prices as known in November 2026; check them in
  the [AWS Pricing Calculator](https://calculator.aws) before quoting.
- Only always-free allowances are subtracted. The 12-month offers and credits of a new account are
  ignored, so a new account pays less.
- The Gemini price is an **assumption** ($0.10 per million input tokens, $0.40 per million output
  tokens, the published Flash-Lite price of the previous model generation). The free Gemini tier
  cannot serve 100 businesses, so the paid tier is counted from the first invoice.

### 100 active businesses

| Service | Usage per month | Cost |
|---|---|---:|
| Lambda (5 functions, arm64) | 0.18 M invocations, 28 k GB-s | $0 |
| API Gateway HTTP API | 0.16 M requests | $0.19 |
| DynamoDB provisioned 5/5 (free tier) | 0.27 M writes, 0.67 M reads, 0.8 GB | $0 |
| DynamoDB point-in-time recovery | 0.8 GB | $0.20 |
| S3 uploads (30 d Standard, 60 d Standard-IA) | 11.7 GB stored, 10 k uploads | $0.27 |
| CloudFront + web bucket | 0.6 GB, 0.05 M requests | $0 |
| SQS (2 queues + 2 DLQs) | 1.37 M requests (mostly idle polling) | $0.15 |
| SNS email | 1430 emails | $0.01 |
| Cognito | 100 monthly active users | $0 |
| CloudWatch logs, 10 alarms, dashboard | 0.1 GB logs | $0 |
| X-Ray | 184 k traces | $0.42 |
| VPC, SSM, Scheduler, Budgets, IAM | no NAT, gateway endpoints only | $0 |
| **AWS total** |  | $1.24 |
| Gemini API, paid tier (assumed price) | 12 k calls | $5.22 |
| **Total with paid Gemini** |  | $6.46 |

Per business: $0.06 a month; per invoice: $0.0006.

With WAF and the customer-managed KMS key switched on: + $10.16 a month.

### 10,000 active businesses

| Service | Usage per month | Cost |
|---|---|---:|
| Lambda (5 functions, arm64) | 18.40 M invocations, 2789 k GB-s | $35.34 |
| API Gateway HTTP API | 16.20 M requests | $19.44 |
| DynamoDB on-demand | 27.40 M writes, 66.60 M reads, 81.6 GB | $48.37 |
| DynamoDB point-in-time recovery | 81.6 GB | $19.98 |
| S3 uploads (30 d Standard, 60 d Standard-IA) | 1171.9 GB stored, 1000 k uploads | $26.81 |
| CloudFront + web bucket | 58.6 GB, 4.80 M requests | $0 |
| SQS (2 queues + 2 DLQs) | 7.31 M requests (mostly idle polling) | $2.53 |
| SNS email | 143000 emails | $2.84 |
| Cognito | 10000 monthly active users | $0 |
| CloudWatch logs, 10 alarms, dashboard | 13.1 GB logs | $5.13 |
| X-Ray | 3548 k traces | $17.24 |
| VPC, SSM, Scheduler, Budgets, IAM | no NAT, gateway endpoints only | $0 |
| **AWS total** |  | $177.66 |
| Gemini API, paid tier (assumed price) | 1243 k calls | $522.06 |
| **Total with paid Gemini** |  | $699.72 |

Per business: $0.07 a month; per invoice: $0.0007.

With WAF and the customer-managed KMS key switched on: + $14.50 a month.

### What the numbers say

- **100 businesses: about $1 a month of AWS**, plus about $5 of Gemini. The architecture stays almost
  entirely inside the always-free allowances; the table still runs on the free provisioned capacity.
- **10 000 businesses: about $180 a month of AWS**, plus about $520 of Gemini: roughly 7 cents per
  business. The AI calls are three quarters of the bill, so the first optimisation at scale is on the
  AI side (smaller images, batch pricing, caching the prompt), not on AWS.
- Cost grows in line with usage (every large item is pay-per-request), and there is no fixed
  cost such as a NAT gateway or an always-on server.
- At 10 000 businesses three settings must change: `table_billing_mode = "PAY_PER_REQUEST"`,
  a higher `api_throttle_rate`, and a Lambda concurrency quota increase (see [load-test.md](load-test.md)).
- The biggest AWS items at scale and how to shrink them: DynamoDB writes (fewer items per invoice
  line), Lambda (the extract function mostly waits for Gemini), S3 (shorter retention or Glacier),
  point-in-time recovery (keep, it is the backup), X-Ray (lower the sampling rate).
