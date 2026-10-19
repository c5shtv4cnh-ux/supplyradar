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
