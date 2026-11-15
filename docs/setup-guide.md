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
make test tf-test      # unit tests + terraform validate + offline plan test
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

Tell Terraform your email for alarms and the budget alert. It is kept out of Git, in a file that is
loaded automatically for every environment:

```bash
echo 'alarm_email = "you@your-mail.com"' > terraform/owner.auto.tfvars
```

Without it (or with a placeholder address) the plan stops with an explanation, so a forgotten setting
can never replace the confirmed alarm subscription.

```bash
make init                            # terraform -chdir=terraform init -reconfigure -backend-config=envs/dev.backend.hcl
make plan                            # terraform -chdir=terraform plan -var-file=envs/dev.tfvars -out=dev.tfplan
make apply                           # terraform -chdir=terraform apply dev.tfplan
make outputs                         # terraform -chdir=terraform output
```

The plan creates well over 100 resources. Important outputs:

| Output | Use |
|---|---|
| `app_url` | the public URL (CloudFront) |
| `dashboard_url` | CloudWatch dashboard for the demo |
| `xray_trace_map_url` | X-Ray service map and traces |
| `security_features` | which optional protections are on |
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

## 9. Optional: plan and deploy from GitHub Actions (OIDC, no stored keys)

Short version (full guide: [cicd.md](cicd.md)):

1. In `terraform/envs/dev.tfvars` uncomment and fill `github_repository` and `state_bucket`
   (add `enable_github_deploy = true` if GitHub should also deploy), then `make plan apply`.
2. Copy the outputs `github_plan_role_arn` and `github_deploy_role_arn`.
3. GitHub → repository → Settings → Secrets and variables → Actions → **Variables**:
   `AWS_PLAN_ROLE_ARN`, `TF_STATE_BUCKET`, `ALARM_EMAIL`, and for deploys `AWS_DEPLOY_ROLE_ARN`.
4. Open a pull request: the *Terraform plan* job adds the plan summary to the run.

Until step 3 is done the plan job is skipped and the deploy workflow refuses to run, so nothing
reaches AWS from GitHub by accident.

## 10. Production environment

Production is a second copy of the stack in the same account, with its own state file, its own
names (`supplyradar-prod-*`) and stricter settings (`terraform/envs/prod.tfvars`).

```bash
cp terraform/envs/prod.backend.hcl.example terraform/envs/prod.backend.hcl     # same bucket, key supplyradar/prod/...
read -s GEMINI_API_KEY && aws ssm put-parameter --name /supplyradar/prod/gemini-api-key \
  --type SecureString --value "$GEMINI_API_KEY"; unset GEMINI_API_KEY
make init plan apply ENV=prod
make init ENV=dev                    # switch the working directory back to the dev state
```

`make init ENV=...` selects which state the following commands work with; a saved plan file can only
be applied to the state it was made from.

What `prod.tfvars` changes compared with dev:

| Setting | Effect | Cost |
|---|---|---|
| `deletion_protection = true` | the table and the user pool cannot be destroyed | free |
| `upload_versioning = true`, `upload_retention_days = 365` | deleted or overwritten invoice files are kept 30 days; originals stay a year | storage only |
| `log_retention_days = 30`, `api_throttle_rate = 20` | longer history, twice the request limit | free tier |
| `enable_waf = true` | firewall in front of CloudFront | about $9 / month |
| `enable_kms = true` | the project's own encryption key | $1 / month |
| `budget_limit_usd = 15` | budget alert that matches the paid features | free |

Prod therefore costs about **$10 a month** while it exists (about $0.35 for one day). To keep it at
$0, set `enable_waf` and `enable_kms` to `false` before the first apply, or `make destroy ENV=prod`
after showing it. Alarms 11 to 20 (the second environment) add $1 a month.

## 11. Updating

- Code or infrastructure change: `make plan apply`. Lambda packages are rebuilt when files change.
- Web app files are uploaded with `Cache-Control: no-cache`, so a page reload shows the new version.
- After every apply: `make smoke` checks that the site is up, HTTPS-only, sends its security headers
  and that the API refuses anonymous requests.
- Switches worth knowing (all in `terraform/variables.tf`): `enable_waf`, `enable_kms`, `enable_csp`,
  `enable_xray`, `enable_point_in_time_recovery`, `table_billing_mode`, `api_route_throttles`.

## 11a. Checks before the defence

```bash
make test tf-test                    # unit tests, terraform validate, offline plan test
pip install checkov==3.4.5 && make security
make smoke                           # the deployed site
make cost                            # cost table for 100 and 10 000 users
```

Load test against the deployed API: [load-test.md](load-test.md).

## 12. Tear down

```bash
make destroy                         # terraform -chdir=terraform destroy -var-file=envs/dev.tfvars
aws ssm delete-parameter --name /supplyradar/dev/gemini-api-key
```

With `deletion_protection = true` (prod) set it to false and apply before destroying.
With `enable_kms = true` the key is scheduled for deletion and disappears after 7 days (no charge while pending).
The state bucket has `prevent_destroy`; remove it by hand when you no longer need the project.
