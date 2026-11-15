variable "name" {
  type = string
}

variable "rate_limit" {
  description = "Requests allowed from one IP address in any 5-minute window."
  type        = number
  default     = 1000
}
