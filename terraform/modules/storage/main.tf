# Private bucket for invoice photos and PDFs. Browsers upload with presigned
# POST (type and size enforced by the policy); nothing is public.

resource "aws_s3_bucket" "uploads" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-S3 (free) by default; SSE-KMS with an S3 Bucket Key when a key is passed in
# (the bucket key cuts KMS requests, and their cost, by about 99 %).
resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

# Versioning keeps the previous copy when a file is overwritten or deleted by mistake.
resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  versioning_configuration {
    status = var.versioning ? "Enabled" : "Suspended"
  }
}

locals {
  # Standard-IA bills at least 30 days, so move files there only when they
  # will live at least 30 more days before they expire.
  move_to_ia = var.ia_transition_days >= 30 && var.retention_days >= var.ia_transition_days + 30
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  # Originals: cheaper storage class after a month, deleted after retention_days
  # (the extracted data stays in DynamoDB).
  rule {
    id     = "expire-originals"
    status = "Enabled"
    filter {
      prefix = "uploads/"
    }
    dynamic "transition" {
      for_each = local.move_to_ia ? [var.ia_transition_days] : []
      content {
        days          = transition.value
        storage_class = "STANDARD_IA"
      }
    }
    expiration {
      days = var.retention_days
    }
  }

  # Housekeeping for the whole bucket: old versions and leftover delete markers.
  rule {
    id     = "clean-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.uploads]
}

resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  cors_rule {
    allowed_methods = ["POST", "GET"]
    allowed_origins = var.allowed_origins
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# Deny any request that is not over HTTPS.
data "aws_iam_policy_document" "tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.uploads.arn,
      "${aws_s3_bucket.uploads.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "uploads" {
  bucket     = aws_s3_bucket.uploads.id
  policy     = data.aws_iam_policy_document.tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.uploads]
}
