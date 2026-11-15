environment = "dev"
region      = "eu-central-1"

# alarm_email is not kept here: pass -var alarm_email=... or put it in
# terraform/owner.auto.tfvars (git-ignored). The plan refuses to run without it.

gemini_model        = "gemini-3.5-flash-lite"
alert_threshold_pct = 5
budget_limit_usd    = 1
log_retention_days  = 7

# Lets you open src/frontend locally (python3 -m http.server 8080) against the dev API.
extra_allowed_origins = ["http://localhost:8080"]

# Protection that is free (or under a cent) is on by default: X-Ray tracing,
# DynamoDB point-in-time recovery, Content-Security-Policy, web app versioning.
# The two switches below cost money every month, so dev keeps them off.
enable_waf = false # about $9/month
enable_kms = false # $1/month

# GitHub Actions roles (optional, see docs/cicd.md). Nothing deploys from
# GitHub until these are set, applied and the role ARNs are saved in GitHub.
# github_repository    = "your-github-user/supplyradar"
# state_bucket         = "supplyradar-tfstate-123456789012"
# enable_github_deploy = true
