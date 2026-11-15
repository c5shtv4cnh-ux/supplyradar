# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `terraform init`: *Failed to get existing workspaces / bucket does not exist* | `envs/dev.backend.hcl` missing or wrong bucket | Run `terraform/bootstrap`, copy `backend_config` output into `envs/dev.backend.hcl` |
| `plan`: *Set your real email: add -var alarm_email=...* | the owner email is not set (it is no longer in tfvars) | `echo 'alarm_email = "you@your-mail.com"' > terraform/owner.auto.tfvars` |
| `plan` wants to replace `aws_sns_topic_subscription.ops_email` | a different `alarm_email` than at the last apply | use the same address as before, otherwise the subscription must be confirmed again |
| `plan` shows changes for the other environment's names | working directory still points at the other state | `make init ENV=dev` (or `prod`) before `make plan ENV=...` |
| `apply`: *EntityAlreadyExists … oidc-provider/token.actions.githubusercontent.com* | the second environment tries to create the account's GitHub provider again | `create_github_oidc_provider = false` in that environment's tfvars |
| `apply`: *WAFInvalidParameterException … scope CLOUDFRONT* | web ACL created outside us-east-1 | the `waf` module must get `providers = { aws = aws.us_east_1 }` (it does in `main.tf`) |
| `apply`: *KMS … AccessDenied* right after `enable_kms = true` | IAM changes take a few seconds to spread | run `make plan apply` again |
| Site is blank, browser console: *Refused to load … Content Security Policy* | the page needs something the policy does not list | add the host to `content_security_policy` in `terraform/main.tf`, or `enable_csp = false` and apply |
| Site answers **403** with a WAF page | your address passed `waf_rate_limit` or matched a managed rule | wait 5 minutes; CloudWatch → WAF → sampled requests shows the rule; raise `waf_rate_limit` |
| GitHub: *Terraform plan* job is skipped | no plan role configured | expected until [cicd.md](cicd.md) setup is done |
| GitHub deploy stops at *Deploy gate* | deployment is not switched on | the run summary says which condition is missing ([cicd.md](cicd.md)) |
| GitHub: *Not authorized to perform sts:AssumeRoleWithWebIdentity* | job runs from a branch or Environment the role does not trust | plan: pull request or `main`; deploy: the job must run in the GitHub Environment `dev` / `prod` |
| GitHub deploy: *The plan deletes or replaces protected resources* | the change would destroy the table, user pool, a bucket or the key | do it by hand from your machine if it is really intended |
| Alarm email `…-logged-errors` | a function caught and logged errors (often Gemini 429 / 5xx) | dashboard → *Recent errors*; nothing is lost while the DLQ alarm is quiet |
| Alarm email `…-queue-backlog` | invoices wait more than 15 minutes | check the extract logs for 429 (Gemini quota) and the Lambda triggers are *Enabled* |
| No traces in X-Ray | `enable_xray = false`, or no traffic in the chosen period | apply with `enable_xray = true`; upload an invoice; widen the time range |
| `terraform init`: *Unsupported argument use_lockfile* | Terraform older than 1.10 | Upgrade Terraform |
| `apply`: *BucketAlreadyExists* | S3 names are global | Names include the account id; if it still clashes change `project` in tfvars |
| `apply`: *Unable to validate the following destination configurations* (S3 notification) | queue policy not ready yet | Run `make plan apply` again |
| `apply`: budget error *AccessDenied* | billing access for IAM users is off | Root user → Account → *IAM user and role access to Billing information* → Activate |
| Site shows "Нет config.js" | opened `index.html` locally | Use `app_url`, or copy `config.example.js` to `config.js` / run `make local` |
| Sign-up: no code email | Cognito default sender, spam folder, 50 emails/day limit | Check spam; for many users configure SES in the user pool |
| Upload fails with *S3 отклонил загрузку* | file > 10 MB or unsupported type; CORS origin | Use JPEG/PNG/PDF; if you use a custom domain add it to `extra_allowed_origins` |
| Invoice stays *AI читает* | Gemini slow or retrying (429) | `aws logs tail /aws/lambda/supplyradar-dev-extract --follow`; retries happen after 60 s, 120 s |
| Invoice becomes *Ошибка* | 3 failed attempts → DLQ | Look for `GeminiError` in extract logs: wrong key (HTTP 400/403), quota (429), wrong model name (404) |
| Extract log: *ParameterNotFound* | SSM key not created for this environment | `aws ssm put-parameter --name /supplyradar/dev/gemini-api-key ...` (setup guide step 6) |
| Extract log: HTTP 404 from Gemini | model id renamed | set `gemini_model` in tfvars to a current Flash-Lite id, `make plan apply` |
| Everything *Нужна проверка* | wrong BIN check digits or dates on your own test invoices | The issue list says which check failed; use `samples/` for the demo |
| No alert email | SNS subscription not confirmed, or price rise below threshold | Settings page shows "Подтвердите подписку"; check the threshold; alerts need two invoices from the same supplier |
| Alert email arrives for nothing | — | Each owner gets only their alerts (filter policy on `user_id`); check the SNS subscription filter in the console |
| API returns 401 | token expired and refresh failed | Sign out and in again |
| API returns 429 | throttling (10 rps; 2 rps on `POST /assistant`, 5 rps on `POST /uploads`) | Raise `api_throttle_rate` or `api_route_throttles` |
| validate function timeouts | VPC function cannot reach DynamoDB | Check gateway endpoints exist and are associated with the private route table (`modules/network`) |
| `terraform destroy` fails on table / user pool | `deletion_protection = true` | Set false, apply, then destroy |
| `terraform destroy` waits long on the validate function, subnets or security group | AWS releases the VPC function's network interfaces slowly | Wait (can take 20+ minutes) and rerun `destroy` if it times out |

## Reading the pipeline state of one invoice

```bash
aws dynamodb query --table-name supplyradar-dev \
  --key-condition-expression "PK = :pk AND begins_with(SK, :sk)" \
  --expression-attribute-values '{":pk":{"S":"USER#<cognito sub>"},":sk":{"S":"INV#"}}' \
  --projection-expression "SK, #s, issues" --expression-attribute-names '{"#s":"status"}'
```

Statuses in order: `uploading → extracting → validating → checked | needs_review`, then
`confirming → confirmed` after a review; `failed` after three unsuccessful extraction attempts.
