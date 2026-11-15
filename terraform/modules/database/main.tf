# Single DynamoDB table (see src/backend/supplyradar/db.py for the key design).
# Provisioned 5/5 capacity stays inside the always-free 25 RCU / 25 WCU;
# billing_mode = PAY_PER_REQUEST removes the capacity ceiling when traffic grows.
# The stream feeds the notify function with new ALERT# items.
# Point-in-time recovery keeps 35 days of continuous backups.

resource "aws_dynamodb_table" "this" {
  name         = var.table_name
  billing_mode = var.billing_mode
  hash_key     = "PK"
  range_key    = "SK"

  read_capacity  = var.billing_mode == "PROVISIONED" ? var.read_capacity : null
  write_capacity = var.billing_mode == "PROVISIONED" ? var.write_capacity : null

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  # Encryption at rest is always on: the AWS-owned key (free) by default,
  # the project's customer-managed KMS key when one is passed in.
  dynamic "server_side_encryption" {
    for_each = var.kms_key_arn == null ? [] : [var.kms_key_arn]
    content {
      enabled     = true
      kms_key_arn = server_side_encryption.value
    }
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  deletion_protection_enabled = var.deletion_protection
}
