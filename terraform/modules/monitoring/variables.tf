variable "name" {
  type = string
}

variable "alarm_email" {
  description = "Owner email for alarms and the budget (empty = no email)."
  type        = string
  default     = ""
}

variable "function_names" {
  type = list(string)
}

variable "queue_names" {
  type = list(string)
}

variable "dlq_names" {
  type = list(string)
}

variable "api_id" {
  type = string
}

variable "table_name" {
  type = string
}

variable "budget_limit_usd" {
  type    = number
  default = 1
}

variable "log_group_names" {
  description = "Function log groups keyed by short name (api, extract, validate, notify, digest)."
  type        = map(string)
  default     = {}
}

variable "api_log_group_name" {
  description = "API Gateway access log group."
  type        = string
}

variable "distribution_id" {
  description = "CloudFront distribution id (dashboard)."
  type        = string
}

variable "web_acl_name" {
  description = "WAF web ACL name for the dashboard (null = WAF is off)."
  type        = string
  default     = null
}

variable "queue_age_threshold_seconds" {
  description = "Alarm when the oldest message in a work queue is older than this."
  type        = number
  default     = 900
}

variable "api_5xx_threshold" {
  description = "5xx responses in 5 minutes that raise the API alarm."
  type        = number
  default     = 5
}

variable "logged_errors_threshold" {
  description = "Logged errors in 5 minutes that raise the alarm."
  type        = number
  default     = 3
}
