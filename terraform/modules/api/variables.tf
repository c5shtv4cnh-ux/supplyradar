variable "name" {
  type = string
}

variable "allowed_origins" {
  type = list(string)
}

variable "jwt_issuer" {
  type = string
}

variable "jwt_audience" {
  description = "Cognito app client id."
  type        = string
}

variable "lambda_invoke_arn" {
  type = string
}

variable "lambda_function_name" {
  type = string
}

variable "routes" {
  description = "Route keys, e.g. \"GET /invoices\"."
  type        = list(string)
}

variable "throttling_burst_limit" {
  type    = number
  default = 20
}

variable "throttling_rate_limit" {
  type    = number
  default = 10
}

variable "log_retention_days" {
  type    = number
  default = 7
}

variable "route_throttles" {
  description = "Per-route limits that override the default, keyed by route key (\"POST /assistant\")."
  type = map(object({
    rate  = number
    burst = number
  }))
  default = {}

  validation {
    condition     = alltrue([for k in keys(var.route_throttles) : contains(var.routes, k)])
    error_message = "Every route_throttles key must be one of var.routes."
  }
}
