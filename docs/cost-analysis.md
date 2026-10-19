# Cost analysis and optimisation

**Expected cost at demo load: $0 per month** (1 owner, ~200 invoices/month). This is an estimate, not a
guarantee: free allowances differ between AWS account plans and change over time. Check
<https://aws.amazon.com/free> and the pricing pages before the defence.

## Demo-load estimate

| Service | Assumed usage / month | Free allowance | Cost |
|---|---|---|---|
| Lambda (5 functions, arm64) | ~3 000 invocations, ~2 000 GB-s | 1 M requests + 400 000 GB-s | $0 |
| API Gateway HTTP API | ~2 000 requests (UI polls every 2 s while processing) | 1 M (12 months); then $1.00 / M | $0 |
| DynamoDB (provisioned 5 RCU / 5 WCU) | < 100 MB | 25 GB + 25 RCU / 25 WCU | $0 |
| DynamoDB Streams | ~1 000 read requests | 2.5 M stream reads | $0 |
| SQS (2 queues + 2 DLQs) | ~3 000 requests incl. polling | 1 M requests | $0 |
| S3 (2 buckets) | < 200 MB, a few thousand requests | 5 GB, 20 000 GET, 2 000 PUT (12 months) | ~$0.01 |
| CloudFront | < 1 GB, < 50 000 requests | 1 TB, 10 M requests | $0 |
| Cognito | 1–5 users | 10 000 MAU | $0 |
| SNS email | < 300 emails | 1 000 emails | $0 |
| EventBridge Scheduler | 4 invocations | 14 M | $0 |
| CloudWatch | 6 log groups (7-day retention), 7 alarms, 1 dashboard | 5 GB logs, 10 alarms, 3 dashboards | $0 |
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
| No WAF, no custom domain | WAF $5+/month, Route 53 $0.50/month | default CloudFront domain |

## Cost controls

- **AWS Budgets:** $1/month, email at 50 % actual and 100 % forecast (`modules/monitoring`).
- **Tags:** every resource has `Project`, `Environment`, `ManagedBy` (provider `default_tags`) for Cost Explorer.
- **Throttling:** API 10 requests/s, burst 20.
- **Tear down:** `terraform destroy` after the defence.

## What it would cost beyond the free tier

Rough monthly estimate for **50 shops × 300 invoices** (15 000 invoices) after free-tier expiry:

| Item | Estimate |
|---|---|
| Lambda (~60 000 invocations, ~40 000 GB-s) | ~$0.70 |
| API Gateway (~300 000 requests) | ~$0.30 |
| DynamoDB on-demand (~1 M writes, 2 M reads) | ~$1.70 |
| S3 + CloudFront | ~$1 |
| Gemini Flash-Lite paid (~20 M tokens) | ~$2–5 |
| **Total** | **≈ $6–9 per month**, about $0.15 per shop |
