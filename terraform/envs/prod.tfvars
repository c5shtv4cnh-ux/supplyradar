environment = "prod"
region      = "eu-central-1"

# alarm_email is not kept here: pass -var alarm_email=... or put it in
# terraform/owner.auto.tfvars (git-ignored). The plan refuses to run without it.

gemini_model        = "gemini-3.5-flash-lite"
alert_threshold_pct = 5
log_retention_days  = 30

# Data is protected against deletion: the table and the user pool cannot be
# destroyed, invoice files keep their previous versions and stay a year.
deletion_protection   = true
upload_versioning     = true
upload_retention_days = 365

# Twice the dev limits.
api_throttle_rate = 20

# Paid protection, on for production. Together about $10/month
# (about $0.35 for a one-day demo): set both to false to stay at $0.
enable_waf = true # about $9/month: web ACL $5 + 4 rules $4, plus $0.60 per million requests
enable_kms = true # $1/month: the project's own encryption key

# The budget alert follows the paid features above.
budget_limit_usd = 15

# GitHub Actions roles (optional, see docs/cicd.md). dev already created the
# account's OIDC provider, so prod only reuses it.
# github_repository           = "your-github-user/supplyradar"
# state_bucket                = "supplyradar-tfstate-123456789012"
# enable_github_deploy        = true
# create_github_oidc_provider = false
