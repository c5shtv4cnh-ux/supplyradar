# 10-minute demonstration script

Matches slide 14 of the presentation. Rehearse twice; record a backup video the day before.

## Before the defence (day before)

- [ ] `make plan` shows *No changes*; `app_url` opens.
- [ ] Demo account registered, alert email confirmed, threshold 5 %.
- [ ] Pre-loaded state: invoices `1-dairy-september` and `2-farm-october` already uploaded,
      so the live upload of #3 triggers the alert. (Keep a second clean account to show from scratch if asked.)
- [ ] `samples/demo/3-dairy-october-price-up.png` and `4-bakery-with-error.png` on the laptop (and printed on paper for a phone photo).
- [ ] Mailbox open in a tab; AWS console signed in on the CloudWatch dashboard; terminal in `terraform/`.
- [ ] Backup: screen recording of the full flow, and `docs/screenshots/`.

## Script

| Time | What to show | What to say |
|---|---|---|
| **0:00–2:00** Problem, sign-in | Title slide → open `app_url` on the phone or laptop, sign in | Small cafés get dozens of paper invoices; price rises go unnoticed until month end. SupplyRadar checks every invoice the day it arrives. Public URL over HTTPS via CloudFront; sign-in with Cognito. |
| **2:00–5:00** Photo → alert | *Накладные* → **Сфотографировать** the printed invoice #3 (or choose the file). Status goes *AI читает → Проверка → Проверено* in ~10 s. Open the invoice, then *Алерты*, then the alert email in the mailbox. Open *Товары → сливки* to show the chart and supplier comparison. | The photo is resized in the browser and uploaded straight to S3 with a presigned POST. S3 puts an event on SQS; a Lambda sends the image to Gemini with a JSON schema; another Lambda checks the numbers and compares prices in DynamoDB. A stream on the table triggers the email through SNS: cream went from 1 500 to 1 680 ₸, +12 %, and another supplier sells it 8 % cheaper. Note that "СЛИВКИ 33% 0,5Л" and "Сливки 33% 0,5 л" were matched as one product. |
| **5:00–6:00** Error → review | Upload `4-bakery-with-error.png` → *Нужна проверка*, row 2 highlighted, message "6 × 290 = 1740, а в накладной 1860". Fix the row and total, **Подтвердить** → *Подтверждено*. | AI alone could misread a digit, and money needs exact numbers. Code runs five checks: quantity × price, sum = total, BIN check digit, date, duplicate number. Only checked or human-confirmed invoices feed the price history. |
| **6:00–8:00** Architecture, console, Terraform | Architecture slide; AWS console: Lambda list, SQS queues + DLQs, DynamoDB items, CloudWatch dashboard. Terminal: `terraform plan -var-file=envs/dev.tfvars` → *No changes*. Show `modules/` tree. | Everything is one `terraform apply`: 11 modules, remote state in S3 with native locking, dev and prod from the same code with different tfvars. The validate function runs in a private VPC with free gateway endpoints and no NAT gateway; one IAM role per function; the Gemini key sits in SSM and never in state. CI runs tests, validate and an offline plan test on every PR, and a real plan via GitHub OIDC. |
| **8:00–10:00** Digest, cost, Q&A | Terminal: `aws lambda invoke --function-name supplyradar-dev-digest out.json` → show the digest email. Cost slide + AWS Budgets page. | Every Monday EventBridge Scheduler triggers a Gemini-written summary of where you overpaid. Expected cost $0/month at demo load, with a $1 budget alarm; the biggest saving is not using a NAT gateway. |

## Likely questions

**Why is the extract function outside the VPC?** It must reach the Gemini API on the internet. Inside a
private subnet that needs a NAT gateway (~$32/month). The function that writes business data (validate) is
inside, with access only to S3 and DynamoDB through gateway endpoints.

**What if Gemini is down or the quota is exhausted?** SQS retries with growing delays; after 3 attempts the
message goes to a dead-letter queue, an alarm emails us, the invoice is marked failed and can be typed in by hand.
Messages can be replayed from the DLQ.

**How accurate is the AI?** Measured with `tests/eval/run_eval.py` on 12 synthetic invoices: field accuracy
\<fill in your number\> %. Errors that remain are caught by the arithmetic checks.

**How do you stop one user from seeing another's data?** The user id comes only from the verified JWT;
all DynamoDB keys are under that id; email subscriptions have a filter policy on it.

**How does it scale?** Lambda, SQS and DynamoDB scale automatically; the limit is the Gemini quota, so the
extract concurrency is capped and the queue absorbs bursts. At 50 shops it would cost about $6–9 per month.

**How is Terraform state protected?** S3 bucket with versioning, encryption, public access blocked,
native lock file; the CI role is read-only and can only take the lock.

**Why DynamoDB and not RDS?** No servers, always-free 25 GB, access patterns are all per-user key lookups
and range queries, and Streams give us event-driven alerts for free.
