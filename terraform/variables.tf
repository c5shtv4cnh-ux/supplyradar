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
  description = "Owner email for CloudWatch alarms and the budget alert."
  type        = string
  default     = ""
}

variable "gemini_model" {
  description = "Gemini model id with a free tier (check Google AI Studio)."
  type        = string
  default     = "gemini-2.5-flash-lite"
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

variable "github_repository" {
  description = "owner/repo for the GitHub Actions OIDC role (empty = skip)."
  type        = string
  default     = ""
}

variable "state_bucket" {
  description = "Terraform state bucket (needed only for the GitHub Actions role)."
  type        = string
  default     = ""
}
