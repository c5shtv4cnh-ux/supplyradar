# Single DynamoDB table (see src/backend/supplyradar/db.py for the key design).
# Provisioned 5/5 capacity stays inside the always-free 25 RCU / 25 WCU.
# The stream feeds the notify function with new ALERT# items.

resource "aws_dynamodb_table" "this" {
  name         = var.table_name
  billing_mode = "PROVISIONED"
  hash_key     = "PK"
  range_key    = "SK"

  read_capacity  = var.read_capacity
  write_capacity = var.write_capacity

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

  # Encryption at rest is always on (AWS-owned key, free) when no KMS key is set.

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  deletion_protection_enabled = var.deletion_protection
}
