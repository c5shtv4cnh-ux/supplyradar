variable "name" {
  type = string
}

variable "github_repository" {
  description = "owner/repo allowed to assume the role."
  type        = string
}

variable "state_bucket" {
  description = "Terraform state bucket name."
  type        = string
}
