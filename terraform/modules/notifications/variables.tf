variable "name" {
  type = string
}

variable "enable_digest" {
  type    = bool
  default = true
}

variable "digest_function_arn" {
  description = "Function invoked by the weekly schedule."
  type        = string
  default     = null
}

variable "digest_schedule" {
  description = "Scheduler expression; default Monday 09:00."
  type        = string
  default     = "cron(0 9 ? * MON *)"
}

variable "digest_timezone" {
  type    = string
  default = "Asia/Almaty"
}
