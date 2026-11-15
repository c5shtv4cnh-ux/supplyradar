variable "bucket_name" {
  type = string
}

variable "allowed_origins" {
  description = "Web app origins allowed to upload from the browser."
  type        = list(string)
}

variable "retention_days" {
  description = "Original files are deleted after this many days (extracted data stays in DynamoDB)."
  type        = number
  default     = 90
}

variable "force_destroy" {
  description = "Allow terraform destroy to delete a non-empty bucket."
  type        = bool
  default     = true
}

variable "versioning" {
  description = "Keep previous versions of overwritten or deleted files."
  type        = bool
  default     = false
}

variable "noncurrent_version_days" {
  description = "Old versions are deleted after this many days."
  type        = number
  default     = 30
}

variable "ia_transition_days" {
  description = "Move originals to Standard-IA after this many days (0 = never; minimum 30)."
  type        = number
  default     = 30
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for the bucket (null = SSE-S3)."
  type        = string
  default     = null
}
