variable "table_name" {
  type = string
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
  description = "Continuous backups (billed per GB; off for the free-tier demo)."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  type    = bool
  default = false
}
