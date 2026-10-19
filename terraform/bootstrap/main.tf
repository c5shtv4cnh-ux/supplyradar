# Run once per AWS account, before the main stack:
#   cd terraform/bootstrap && terraform init && terraform apply
# Creates the versioned, encrypted S3 bucket that stores Terraform state.
# Locking uses Terraform's native S3 lock file (use_lockfile), so no DynamoDB
# lock table is needed. This configuration keeps its own state locally.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "supplyradar"
      ManagedBy = "terraform"
      Component = "bootstrap"
    }
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "state" {
  bucket = "supplyradar-tfstate-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "backend_config" {
  description = "Paste into terraform/envs/<env>.backend.hcl"
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.state.id}"
    region       = "${var.region}"
    use_lockfile = true
    encrypt      = true
  EOT
}
