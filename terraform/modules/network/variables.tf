variable "name" {
  description = "Name prefix for network resources."
  type        = string
}

variable "cidr_block" {
  type    = string
  default = "10.20.0.0/16"
}
