variable "name" {
  type = string
}

variable "visibility_timeout_seconds" {
  description = "Must be at least 6x the consumer Lambda timeout."
  type        = number
  default     = 360
}

variable "max_receive_count" {
  description = "Attempts before a message moves to the DLQ."
  type        = number
  default     = 3
}

variable "allow_s3_source" {
  description = "Create a queue policy that lets s3_source_bucket_arn send events."
  type        = bool
  default     = false
}

variable "s3_source_bucket_arn" {
  description = "Bucket allowed to publish events to this queue."
  type        = string
  default     = null
}
