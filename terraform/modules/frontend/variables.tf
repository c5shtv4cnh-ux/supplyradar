variable "bucket_name" {
  type = string
}

variable "source_dir" {
  description = "Directory with the static web app files."
  type        = string
}

variable "app_config" {
  description = "Values written to config.js for the browser."
  type        = map(string)
}

variable "comment" {
  type    = string
  default = "SupplyRadar web app"
}

variable "web_acl_arn" {
  description = "ARN of a WAFv2 web ACL (scope CLOUDFRONT, us-east-1) to attach; null = none."
  type        = string
  default     = null
}

variable "content_security_policy" {
  description = "Content-Security-Policy header value; empty keeps the AWS managed security headers."
  type        = string
  default     = ""
}

variable "versioning" {
  description = "Keep previous versions of the web app files for 30 days (rollback)."
  type        = bool
  default     = true
}
