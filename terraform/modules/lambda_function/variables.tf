variable "name" {
  description = "Function name, also used for the role and log group."
  type        = string
}

variable "description" {
  type    = string
  default = ""
}

variable "source_dir" {
  description = "Directory zipped as the deployment package."
  type        = string
}

variable "handler" {
  description = "Python handler, e.g. api.handler."
  type        = string
}

variable "runtime" {
  type    = string
  default = "python3.13"
}

variable "timeout" {
  type    = number
  default = 10
}

variable "memory_size" {
  type    = number
  default = 256
}

variable "environment" {
  type    = map(string)
  default = {}
}

variable "policy_json" {
  description = "IAM policy (JSON) with exactly the permissions this function needs."
  type        = string
}

variable "vpc_config" {
  description = "Set to place the function in private subnets."
  type = object({
    subnet_ids         = list(string)
    security_group_ids = list(string)
  })
  default = null
}

variable "log_retention_days" {
  type    = number
  default = 7
}
