environment = "dev"
region      = "eu-central-1"

# Owner email for alarms and the $1 budget alert (you must confirm the SNS email).
alarm_email = "you@example.com"

gemini_model        = "gemini-2.5-flash-lite"
alert_threshold_pct = 5
budget_limit_usd    = 1
log_retention_days  = 7

# Lets you open src/frontend locally (python3 -m http.server 8080) against the dev API.
extra_allowed_origins = ["http://localhost:8080"]

# GitHub Actions OIDC role for `terraform plan` on pull requests (optional).
# github_repository = "your-github-user/supplyradar"
# state_bucket      = "supplyradar-tfstate-123456789012"
