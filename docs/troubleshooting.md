# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `terraform init`: *Failed to get existing workspaces / bucket does not exist* | `envs/dev.backend.hcl` missing or wrong bucket | Run `terraform/bootstrap`, copy `backend_config` output into `envs/dev.backend.hcl` |
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
| API returns 429 | throttling (10 rps) | Raise `api_throttle_rate` |
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
