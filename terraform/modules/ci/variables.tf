variable "name" {
  type = string
}

variable "github_repository" {
  description = "owner/repo allowed to assume the roles."
  type        = string
}

variable "state_bucket" {
  description = "Terraform state bucket name."
  type        = string
}

variable "state_key_prefix" {
  description = "Folder of this environment's state inside the bucket, e.g. supplyradar/dev."
  type        = string
}

variable "protected_state_prefixes" {
  description = "State folders of other environments that the deploy role must not touch."
  type        = list(string)
  default     = []
}

variable "create_oidc_provider" {
  description = "Create the account's GitHub OIDC provider (true in one environment only)."
  type        = bool
  default     = true
}

variable "create_deploy_role" {
  description = "Also create the role that may run terraform apply from GitHub Actions."
  type        = bool
  default     = false
}

variable "github_environment" {
  description = "GitHub Environment whose jobs may assume the deploy role."
  type        = string
}

variable "uploads_bucket_arn" {
  description = "Invoice uploads bucket: the plan role is denied reading its objects."
  type        = string
  default     = null
}
