variable "name" {
  type = string
}

variable "deletion_window_in_days" {
  description = "Waiting period before a deleted key is really gone (7 to 30 days)."
  type        = number
  default     = 7
}
