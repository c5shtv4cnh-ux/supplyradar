# Setup guide

From an empty AWS account to a working public URL. Expect about an hour the first time;
CloudFront alone takes 5–10 minutes to deploy.

Commands are shown with `make` shortcuts and, for Windows without `make`, the plain Terraform equivalent.

## 1. Tools

| Tool | Version | Check |
|---|---|---|
| Terraform | ≥ 1.10 (native S3 locking) | `terraform version` |
| AWS CLI | v2 | `aws --version` |
| Python | ≥ 3.12 | `python3 --version` |
| Git | any | `git --version` |

```bash
python3 -m pip install -r requirements-dev.txt
make test tf-test      # 29 unit tests + terraform validate + offline plan test
```

## 2. AWS account

1. Create an AWS account (Free plan is fine: this stack is designed to stay within it).
2. Turn on MFA for the root user, then stop using root.
3. Create an admin identity for yourself: IAM Identity Center user (recommended, `aws configure sso`)
   or an IAM user with `AdministratorAccess` and an access key (`aws configure`).
4. Region: `eu-central-1` (Frankfurt). Check: `aws sts get-caller-identity`.

> The AWS Free plan closes the account after 6 months or when the credits run out.
> Keep `budget_limit_usd = 1` and run `terraform destroy` after the defence.

## 3. Gemini API key and model

1. Open <https://aistudio.google.com>, sign in, **Get API key → Create API key**.
2. Check which Flash-Lite model has a free tier today (AI Studio → model list, or
   <https://ai.google.dev/gemini-api/docs/pricing>). The default is `gemini-3.5-flash-lite`
   (`gemini-2.5-flash-lite` is no longer offered to new API users, checked 2026-10-20);
   if Google renamed it again, set `gemini_model` in `terraform/envs/*.tfvars`.
3. Week 1 checkpoint, the accuracy test (≥ 80 % of fields correct):

```bash
export GEMINI_API_KEY=...            # Windows PowerShell: $env:GEMINI_API_KEY="..."
make eval                            # or: python3 tests/eval/run_eval.py --out eval-report.json
```

It prints per-invoice results and the overall field accuracy; put the number in your report.
Only synthetic invoices from `samples/` are used, because free-tier inputs may be used by Google.

## 4. GitHub repository

```bash
git init && git add . && git commit -m "SupplyRadar: initial import"
git branch -M main
git remote add origin https://github.com/<you>/supplyradar.git
git push -u origin main
```

CI runs the unit tests, `terraform fmt/validate` and the offline plan test on every push and PR.

## 5. Remote state (once per account)

```bash
cd terraform/bootstrap
terraform init
terraform apply                      # creates supplyradar-tfstate-<account id>
terraform output -raw backend_config
cd ../..
cp terraform/envs/dev.backend.hcl.example terraform/envs/dev.backend.hcl
# edit dev.backend.hcl: bucket = "supplyradar-tfstate-<account id>"
```

State is versioned and encrypted; locking uses Terraform's native S3 lock file (`use_lockfile = true`),
so no DynamoDB lock table is needed.

## 6. Store the Gemini key in SSM

```bash
aws ssm put-parameter --region eu-central-1 \
  --name /supplyradar/dev/gemini-api-key \
  --type SecureString \
  --value "$GEMINI_API_KEY"
```

Terraform only references the parameter by name, so the key never enters Git or the state file.
To rotate: run the same command with `--overwrite`; the next cold start of the functions picks it up.

## 7. Configure and deploy

Edit `terraform/envs/dev.tfvars`: set `alarm_email` to your address.

```bash
make init                            # terraform -chdir=terraform init -reconfigure -backend-config=envs/dev.backend.hcl
make plan                            # terraform -chdir=terraform plan -var-file=envs/dev.tfvars -out=dev.tfplan
make apply                           # terraform -chdir=terraform apply dev.tfplan
make outputs                         # terraform -chdir=terraform output
```

The plan creates about 100 resources. Important outputs:

| Output | Use |
|---|---|
| `app_url` | the public URL (CloudFront) |
| `dashboard_url` | CloudWatch dashboard for the demo |
| `function_names` | for logs: `aws logs tail /aws/lambda/<name> --follow` |

Right after apply:

1. Confirm the email **AWS Notification – Subscription Confirmation** (ops alarms).
2. Open `app_url`, register with your email, enter the code from the Cognito email, sign in.
3. **Настройки** → enter your email → confirm the second subscription email (price alerts).

## 8. Try the demo flow

Upload in this order from `samples/demo/` (see [demo-script.md](demo-script.md)):

1. `1-dairy-september.png` → *Проверено*
2. `2-farm-october.png` → *Проверено* (same products, different printed names, other supplier)
3. `3-dairy-october-price-up.png` → *Проверено*, alert email: cream +12 %, cheaper at «Свежая ферма»
4. `4-bakery-with-error.png` → *Нужна проверка*, row 2 highlighted; fix 1860 → 1740 and total 6460 → 6340, confirm

Weekly digest without waiting for Monday:

```bash
aws lambda invoke --function-name supplyradar-dev-digest /dev/stdout
```

## 9. Optional: Terraform plan in GitHub Actions (OIDC, no stored keys)

1. In `terraform/envs/dev.tfvars` uncomment and fill `github_repository` and `state_bucket`, then `make plan apply`.
2. Copy the output `github_plan_role_arn`.
3. GitHub → repository → Settings → Secrets and variables → Actions → **Variables**:
   `AWS_PLAN_ROLE_ARN` (the ARN), `TF_STATE_BUCKET` (state bucket), `ALARM_EMAIL` (same as tfvars).
4. Open a pull request: the *Terraform plan (dev)* job adds the plan summary to the run.

The OIDC provider is one per AWS account, so enable this in one environment only (dev).

## 10. Production environment

```bash
cp terraform/envs/prod.backend.hcl.example terraform/envs/prod.backend.hcl     # same bucket, key .../prod/...
aws ssm put-parameter --name /supplyradar/prod/gemini-api-key --type SecureString --value "$GEMINI_API_KEY"
make init plan apply ENV=prod
```

`prod.tfvars` turns on deletion protection for the table and user pool, keeps logs 14 days and raises throttling.
Both environments can live in one account: every resource name contains the environment.

## 11. Updating

- Code or infrastructure change: `make plan apply`. Lambda packages are rebuilt when files change.
- Web app files are uploaded with `Cache-Control: no-cache`, so a page reload shows the new version.

## 12. Tear down

```bash
make destroy                         # terraform -chdir=terraform destroy -var-file=envs/dev.tfvars
aws ssm delete-parameter --name /supplyradar/dev/gemini-api-key
```

With `deletion_protection = true` (prod) set it to false and apply before destroying.
The state bucket has `prevent_destroy`; remove it by hand when you no longer need the project.
