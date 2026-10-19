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
