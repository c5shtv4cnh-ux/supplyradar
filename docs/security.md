# Security

What protects SupplyRadar, what each layer costs, and which risks are accepted on purpose.
Everything here is Terraform code in `terraform/`; nothing is configured by hand in the console.

## Layers at a glance

| Layer | Protection | Where | Monthly cost | Default |
|---|---|---|---|---|
| Edge | HTTPS only (HTTP redirects), HTTP/2 and 3, AWS Shield Standard | `modules/frontend` | free | on |
| Edge | Security headers: HSTS, Content-Security-Policy, no framing, no MIME sniffing, Permissions-Policy | `modules/frontend` | free | on (`enable_csp`) |
| Edge | **AWS WAF**: 1 000 requests / 5 min per IP, IP reputation list, common rule set, known bad inputs | `modules/waf` | ≈ $9 + $0.60 per million requests | **off** in dev, on in prod (`enable_waf`) |
| Identity | Cognito: verified email, JWT, tokens live 60 minutes, token revocation, no user-existence leaks | `modules/auth` | free up to 10 000 users | on |
| API | JWT authorizer on every route, CORS limited to the site's own origin | `modules/api` | free | on |
| API | **Rate limits**: 10 req/s (burst 20) per environment; 2 req/s on `POST /assistant`, 5 req/s on `POST /uploads` | `modules/api` | free | on |
| Compute | One IAM role per function with exact ARNs (`terraform/iam.tf`) | `modules/lambda_function` | free | on |
| Network | The function that writes business data runs in private subnets with no internet route | `modules/network` | free (no NAT) | on |
| Data | Encryption at rest everywhere: S3, DynamoDB, SQS, SNS | all modules | free (AWS-owned keys) | on |
| Data | **Customer-managed KMS key** with yearly rotation for the table, the uploads bucket and the queues | `modules/kms` | $1 | **off** in dev, on in prod (`enable_kms`) |
| Data | Buckets: Block Public Access, TLS-only bucket policies, web bucket readable only by CloudFront (OAC) | `modules/storage`, `modules/frontend` | free | on |
| Data | DynamoDB point-in-time recovery (35 days), deletion protection in prod | `modules/database` | cents | on |
| Secrets | Gemini key is an SSM SecureString; Terraform knows only its name | setup guide step 6 | free | on |
| Pipeline | GitHub Actions uses short-lived OIDC tokens, no stored AWS keys | `modules/ci` | free | off until set up |
| Detection | 10 alarms, dashboard, X-Ray traces, $ budget alert | `modules/monitoring` | free tier | on |
| Code | Checkov scan of the Terraform code on every pull request | `.checkov.yaml` | free | on |

The two paid switches are in `terraform/envs/*.tfvars`:

```hcl
enable_waf = true   # about $9/month, billed per hour: a one-day demo costs about $0.30
enable_kms = true   # $1/month
```

## Web application firewall (WAF)

`enable_waf = true` creates a WAFv2 web ACL (in `us-east-1`, where CloudFront ACLs live) and attaches
it to the distribution. Rules, in order:

1. `rate-limit-per-ip`: more than `waf_rate_limit` (1 000) requests from one address in 5 minutes are blocked.
2. `AWSManagedRulesAmazonIpReputationList`: addresses AWS already knows as bots or attackers.
3. `AWSManagedRulesCommonRuleSet`: generic web attack patterns (OWASP style).
4. `AWSManagedRulesKnownBadInputsRuleSet`: exploit probes such as Log4Shell.

Blocked and allowed requests appear on the dashboard. **What WAF does not cover:** the API. API Gateway
HTTP APIs cannot have a web ACL attached; the API is protected by the JWT authorizer and by throttling
instead. Putting the API behind the same CloudFront distribution (so WAF sees it too) is the next
step for a real launch.

## API rate limits

| Scope | Limit | Why |
|---|---|---|
| Every route (`api_throttle_rate`) | 10 req/s, burst 20 (prod: 20 / 40) | a runaway client cannot exhaust Lambda or DynamoDB |
| `POST /assistant` | 2 req/s, burst 4 | each call is a paid Gemini request |
| `POST /uploads` | 5 req/s, burst 10 | each upload starts the AI pipeline |
| Assistant, per user | 30 questions a day (application code) | fair use on the Pro plan |
| Extract function | 2 at a time (event source `maximum_concurrency`) | stays under the Gemini quota; the queue absorbs bursts |

Above the limit API Gateway answers `429 Too Many Requests`; the load test in
[load-test.md](load-test.md) shows where that starts. HTTP APIs throttle per route, not per user:
per-user quotas would need REST API usage plans or a counter in DynamoDB.

## Content-Security-Policy

CloudFront sends this header with every page (built in `terraform/main.tf`):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://<uploads bucket>.s3.eu-central-1.amazonaws.com;
font-src 'self';
connect-src 'self' https://*.execute-api.eu-central-1.amazonaws.com
            https://cognito-idp.eu-central-1.amazonaws.com https://<uploads bucket>.s3.eu-central-1.amazonaws.com;
form-action 'self' https://<uploads bucket>...; frame-ancestors 'none'; base-uri 'self'; object-src 'none'
```

The app has no inline scripts and loads nothing from third parties, so `script-src 'self'` is strict:
if a script were ever injected into a page, the browser would refuse to run it and could not send data
anywhere except the project's own API. `style-src` allows inline styles because the app sets `style`
attributes. The whole browser test (`tests/e2e/ui.spec.mjs`) passes with the policy applied.
If the header ever blocks something legitimate, set `enable_csp = false` and apply: the distribution
falls back to the AWS managed security headers.

## Encryption

| Data | Default (free) | With `enable_kms = true` |
|---|---|---|
| DynamoDB table and stream | AWS-owned key | project key `alias/supplyradar-<env>` |
| Uploads bucket | SSE-S3 (AES-256) | SSE-KMS with an S3 Bucket Key |
| SQS queues and DLQs | SSE-SQS | project key, data keys reused for 1 hour |
| SNS alerts topic | AWS managed key `aws/sns` | unchanged |
| Web bucket, Terraform state | SSE-S3 | unchanged (public site files; state has no secrets) |
| In transit | TLS everywhere; buckets deny plain HTTP | same |

The data is encrypted either way. The customer-managed key adds control: its policy and the IAM
statements in `terraform/iam.tf` name exactly who may decrypt (each function, only through DynamoDB,
S3 or SQS), every use is recorded in CloudTrail, the key rotates every year, and disabling it makes
the data unreadable at once.

## IAM least-privilege review

Reviewed in November 2026; findings and what was done:

| Finding | Risk | Change |
|---|---|---|
| The GitHub plan role had `ReadOnlyAccess`, which also reads **data**: invoice files, table items, the Gemini key in SSM, the Cognito user list | a leaked workflow token could read customer data | explicit `Deny` on data reads (`dynamodb:GetItem/Query/Scan`, `s3:GetObject` on uploads, `ssm:GetParameter*`, `kms:Decrypt`, `cognito-idp:ListUsers`, log reads) |
| The plan role trusted any branch or tag of the repository (`repo:…:*`) | a token from an arbitrary ref could assume it | trust limited to pull requests and `main` |
| The plan role could read every state file in the bucket | dev plan could read prod state | limited to `supplyradar/<env>/*` |
| The handled failures of the queue workers did not raise any alarm | silent failures | log metric filter + `logged-errors` alarm ([monitoring.md](monitoring.md)) |
| The web and state buckets accepted plain HTTP | downgrade | TLS-only bucket policies |
| The alarm email placeholder in tfvars could replace the confirmed subscription | lost alarms | the address is no longer in tfvars; a missing or placeholder value stops the plan |
| Function roles | checked: every statement names one table, one bucket prefix, one queue, one topic or one parameter | no change; `dynamodb:ListStreams` and X-Ray writes need `*` because AWS has no resource form for them |

The **deploy role** (optional) is the widest identity in the project and is built to be hard to misuse:

- it can be assumed only by a job running in the GitHub Environment named after the AWS environment
  (`repo:<owner>/<repo>:environment:prod`), which is where a required reviewer is configured;
- `PowerUserAccess` (no IAM) plus IAM rights limited to roles named `supplyradar-<env>-*`, and
  `iam:PassRole` only to Lambda and EventBridge Scheduler;
- explicit `Deny` on changing the GitHub roles or the OIDC provider: the pipeline cannot widen its own access;
- explicit `Deny` on the other environment's state.

## Accepted risks

| Risk | Why accepted | What would close it |
|---|---|---|
| dev and prod share one AWS account | a student account; names, state and budgets are separate | one account per environment (AWS Organizations) |
| The deploy role can create a new `supplyradar-<env>-*` role with broad rights | Terraform must create the function roles | an IAM permissions boundary on every role |
| WAF does not see API traffic | HTTP APIs do not support WAF | route the API through CloudFront |
| No MFA in Cognito | simpler sign-in for café owners in the demo | optional TOTP in the user pool |
| The extract function is outside the VPC | a NAT gateway costs about $32/month | NAT or a proxy for Gemini calls |
| Default `cloudfront.net` certificate allows TLS 1.0 clients | the minimum TLS version can be raised only with a custom domain | own domain + ACM certificate |
| The free Gemini tier may use inputs for training | only synthetic invoices are used | paid Gemini tier |

## Rotating the Gemini API key

The key that was used during development was pasted into a chat, so treat it as exposed.
Before real data is processed (and after the defence at the latest):

1. Google AI Studio → API keys → delete the old key, create a new one.
2. Store it without printing it:

```bash
read -s GEMINI_API_KEY && aws ssm put-parameter --region eu-central-1 \
  --name /supplyradar/dev/gemini-api-key --type SecureString --value "$GEMINI_API_KEY" --overwrite
unset GEMINI_API_KEY
```

3. The functions read the key on their next cold start (within minutes; to force it, change any
   function setting or redeploy). Never paste the key into chats, issues or commits.

## Incident quick reference

| Situation | First action |
|---|---|
| Suspicious traffic on the site | set `enable_waf = true`, apply; lower `waf_rate_limit` |
| API abuse | lower `api_throttle_rate` / `api_route_throttles`, apply |
| Leaked Gemini key | rotate as above |
| Leaked AWS access key | IAM → deactivate the key; check CloudTrail; create a new one |
| Data deleted or corrupted | restore the table to a minute before the incident ([monitoring.md](monitoring.md#backups-and-restore)) |
| A user must be locked out | Cognito → user → disable; tokens expire within 60 minutes |
