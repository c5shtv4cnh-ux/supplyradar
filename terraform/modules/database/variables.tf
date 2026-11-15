variable "table_name" {
  type = string
}

variable "billing_mode" {
  description = "PROVISIONED (free-tier capacity) or PAY_PER_REQUEST (on-demand)."
  type        = string
  default     = "PROVISIONED"

  validation {
    condition     = contains(["PROVISIONED", "PAY_PER_REQUEST"], var.billing_mode)
    error_message = "billing_mode must be PROVISIONED or PAY_PER_REQUEST."
  }
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for the table (null = AWS-owned key)."
  type        = string
  default     = null
}

variable "read_capacity" {
  type    = number
  default = 5
}

variable "write_capacity" {
  type    = number
  default = 5
}

variable "point_in_time_recovery" {
  description = "Continuous backups, restore to any second of the last 35 days (billed per GB stored)."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  type    = bool
  default = false
}
