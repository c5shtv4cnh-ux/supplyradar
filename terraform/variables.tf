variable "project" {
  description = "Project name, used as a prefix for every resource."
  type        = string
  default     = "supplyradar"
}

variable "environment" {
  description = "Environment name: dev or prod."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "alarm_email" {
  description = "Owner email for CloudWatch alarms and the budget alert. Not kept in the tfvars files: pass -var alarm_email=... or put it in terraform/owner.auto.tfvars (git-ignored)."
  type        = string
  default     = ""

  # A missing or placeholder address would silently replace the confirmed
  # email subscription of the alarms, so the plan stops instead.
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email)) && var.alarm_email != "you@example.com"
    error_message = "Set your real email: add -var alarm_email=you@your-mail.com to the command, or create terraform/owner.auto.tfvars with the line alarm_email = \"you@your-mail.com\"."
  }
}

variable "admin_emails" {
  description = "Comma-separated emails that may open the admin panel. Empty: the alarm_email owner."
  type        = string
  default     = ""
}

variable "gemini_model" {
  description = "Gemini model id with a free tier (check Google AI Studio)."
  type        = string
  default     = "gemini-3.5-flash-lite"
}

variable "gemini_key_param" {
  description = "SSM SecureString holding the Gemini API key. Created with the AWS CLI, never by Terraform, so the key is not stored in state."
  type        = string
  default     = null
}

variable "alert_threshold_pct" {
  description = "Default price increase (%) that triggers an alert."
  type        = number
  default     = 5
}

variable "budget_limit_usd" {
  type    = number
  default = 1
}

variable "log_retention_days" {
  type    = number
  default = 7
}

variable "upload_retention_days" {
  type    = number
  default = 90
}

variable "deletion_protection" {
  description = "Protect the table and user pool from deletion (use in prod)."
  type        = bool
  default     = false
}

variable "extra_allowed_origins" {
  description = "Extra web origins allowed by CORS, e.g. http://localhost:8080 for local UI work."
  type        = list(string)
  default     = []
}

variable "api_throttle_rate" {
  description = "Steady-state API requests per second."
  type        = number
  default     = 10
}

variable "api_route_throttles" {
  description = "Tighter per-route limits (requests per second and burst) for routes that cost money per call."
  type = map(object({
    rate  = number
    burst = number
  }))
  default = {
    "POST /assistant" = { rate = 2, burst = 4 }  # every call is a Gemini request
    "POST /uploads"   = { rate = 5, burst = 10 } # every call starts the AI pipeline
  }

  validation {
    condition     = alltrue([for k in keys(var.api_route_throttles) : contains(local.api_routes, k)])
    error_message = "Every api_route_throttles key must be an existing route, written like \"POST /assistant\"."
  }
}

# ---------------------------------------------------------------- security switches

variable "enable_waf" {
  description = "AWS WAF in front of CloudFront: rate limit per IP and AWS managed rules. Costs about $9/month plus $0.60 per million requests (no free tier)."
  type        = bool
  default     = false
}

variable "waf_rate_limit" {
  description = "Requests one IP address may send in 5 minutes before WAF blocks it."
  type        = number
  default     = 1000
}

variable "enable_kms" {
  description = "Encrypt the table, the uploads bucket and the queues with the project's own KMS key instead of AWS-owned keys. Costs $1/month (no free tier)."
  type        = bool
  default     = false
}

variable "enable_csp" {
  description = "Send a Content-Security-Policy header from CloudFront (free)."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------- observability, backups, storage

variable "enable_xray" {
  description = "X-Ray active tracing on all functions. The first 100 000 traces a month are free."
  type        = bool
  default     = true
}

variable "enable_point_in_time_recovery" {
  description = "DynamoDB continuous backups (35 days). About $0.24 per GB a month, under one cent for this table."
  type        = bool
  default     = true
}

variable "table_billing_mode" {
  description = "PROVISIONED (5/5, inside the free tier) or PAY_PER_REQUEST (no capacity ceiling, pay per request)."
  type        = string
  default     = "PROVISIONED"
}

variable "upload_ia_transition_days" {
  description = "Move invoice originals to the cheaper Standard-IA class after this many days (0 = never)."
  type        = number
  default     = 30
}

variable "upload_versioning" {
  description = "Keep previous versions of invoice files for 30 days (protects against accidental deletion)."
  type        = bool
  default     = false
}

variable "web_versioning" {
  description = "Keep previous versions of the web app files for 30 days (rollback)."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------- GitHub Actions (all off until set)

variable "github_repository" {
  description = "owner/repo for the GitHub Actions OIDC roles (empty = no roles, workflows stay skipped)."
  type        = string
  default     = ""
}

variable "enable_github_deploy" {
  description = "Also create the role that lets GitHub Actions run terraform apply for this environment."
  type        = bool
  default     = false
}

variable "create_github_oidc_provider" {
  description = "Create the account-wide GitHub OIDC provider. True in the first environment, false in the second one in the same account."
  type        = bool
  default     = true
}

variable "state_bucket" {
  description = "Terraform state bucket (needed only for the GitHub Actions roles)."
  type        = string
  default     = ""
}
