# SupplyRadar

**Catch supplier price increases the day the invoice arrives.**

A café or shop owner photographs a supplier invoice. Gemini reads it into structured JSON,
code checks every number, and the price history in DynamoDB is updated. If a product now costs
more than last time (default threshold +5 %), the owner gets an email, including a cheaper supplier
when one exists. Every Monday a plain-language digest summarises where they overpaid.

Final project for *Cloud-Native AI Application Deployment* (IITU). Fully serverless on AWS,
built with Terraform, designed to run at **$0/month** at demo load.

![Price alert](docs/screenshots/03-alerts.png)

## Architecture

```mermaid
flowchart LR
  U[Browser SPA] -->|HTTPS| CF[CloudFront] --> W[(S3 web)]
  U -->|sign in| COG[Cognito]
  U -->|JWT| APIGW[API Gateway HTTP API] --> API[api Lambda]
  API -->|presigned POST| U
  U -->|upload photo/PDF| UP[(S3 uploads)]
  UP -->|ObjectCreated| Q1[[SQS extract + DLQ]] --> EX[extract Lambda] -->|image| GEM{{Gemini API}}
  EX --> Q2[[SQS validate + DLQ]] --> VA[validate Lambda<br/>in VPC]
  API -->|confirmed review| Q2
  VA -->|gateway endpoint| DB[(DynamoDB)]
  DB -->|Streams: ALERT#| NO[notify Lambda] --> SNS[SNS email]
  SCH[EventBridge Scheduler<br/>weekly] --> DG[digest Lambda] --> GEM
  DG --> SNS
```

13 AWS services: S3, CloudFront, Cognito, API Gateway, Lambda (5 functions), SQS (2 queues + 2 DLQs),
DynamoDB (+ Streams), SNS, EventBridge Scheduler, VPC (private subnets, gateway endpoints, no NAT),
SSM Parameter Store, CloudWatch (+ Budgets), IAM (one role per function, GitHub OIDC).

Details: [docs/architecture.md](docs/architecture.md).

## Repository layout

```
terraform/
  main.tf variables.tf outputs.tf   root stack (one per environment via tfvars)
  iam.tf versions.tf
  bootstrap/                        remote state bucket (run once per account)
  envs/                             dev.tfvars, prod.tfvars, *.backend.hcl.example
  modules/                          11 modules: network storage database queue auth api
                                    frontend lambda_function monitoring notifications ci
  tests/plan.tftest.hcl             offline plan test with a mocked AWS provider
src/
  backend/                          Python 3.13 Lambda code (stdlib + boto3 only)
    api.py extract.py validate.py notify.py digest.py
    supplyradar/                    shared: checks, pricing, products, gemini, db
  frontend/                         HTML + JS single-page app (Russian UI), no build step
scripts/make_sample_invoices.py     synthetic invoices + ground truth
samples/                            eval/ (12 invoices) and demo/ (4-step live demo)
tests/unit/                         pytest (29 tests)
tests/eval/run_eval.py              Gemini field-accuracy test (Week 1 checkpoint, target >= 80 %)
tests/e2e/                          local fake backend + Playwright browser test
docs/                               architecture, setup guide, cost, monitoring,
                                    troubleshooting, demo script, interview guide
.github/workflows/ci.yml            tests, terraform validate/test, plan via OIDC
```

## Quick start

Full step-by-step instructions: [docs/setup-guide.md](docs/setup-guide.md).

```bash
# 0. tools: Terraform >= 1.10, AWS CLI v2, Python 3.12+
python3 -m pip install -r requirements-dev.txt
make test tf-test                     # everything offline, no AWS needed

# 1. state bucket (once)
cd terraform/bootstrap && terraform init && terraform apply && cd ../..
cp terraform/envs/dev.backend.hcl.example terraform/envs/dev.backend.hcl   # put the bucket name

# 2. Gemini key -> SSM (never in Git or Terraform state)
aws ssm put-parameter --name /supplyradar/dev/gemini-api-key --type SecureString --value "$GEMINI_API_KEY"

# 3. deploy (edit alarm_email in terraform/envs/dev.tfvars first)
make init plan apply
make outputs                          # app_url = https://xxxx.cloudfront.net
```

Then open `app_url`, sign up, upload `samples/demo/1-…png`, `2-…`, `3-…` in order and watch the
price alert arrive. Tear down after the defence with `make destroy`.

## Local development without AWS

```bash
make local                            # http://localhost:8765, real API code + fake AWS
```

Uploading any file from `samples/` behaves like the real pipeline (its ground truth replaces Gemini).

## AI accuracy (Week 1 checkpoint)

Measured 2026-10-20 with `gemini-3.5-flash-lite` on the 12 synthetic invoices in `samples/eval`
(`tests/eval/run_eval.py`):

| Metric | Result | Target |
|---|---|---|
| Field accuracy (BIN, number, date, total, every line's name, qty, price, total, product match) | **253 / 255 = 99.2 %** | ≥ 80 % |
| Invoices where the 5 checks gave the right verdict | **12 / 12** | |
| Demo set (`samples/demo`, incl. the invoice with an arithmetic error) | 74 / 75 fields, 4 / 4 verdicts | |
| Time per invoice | 1.8–7.3 s (median ≈ 2.3 s) | ~10 s end to end |

The only misses were a product name normalised as «яйцо с1 10 шт» instead of «яйца с1 10 шт».
Cross-supplier matching worked: «СЛИВКИ 33% 0,5Л» and «Сливки 33% 0,5 л» became one product.

## Testing

| What | Command | Needs |
|---|---|---|
| Unit tests (checks, pricing, handlers) | `make test` | Python |
| Terraform fmt / validate / offline plan | `make tf-test` | Terraform |
| AI extraction accuracy | `GEMINI_API_KEY=… make eval` | Gemini key |
| Browser test of the web app | `make local` then `node tests/e2e/ui.spec.mjs` | Node + Playwright |
