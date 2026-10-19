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
