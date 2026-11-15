output "table_name" {
  value = aws_dynamodb_table.this.name
}

output "table_arn" {
  value = aws_dynamodb_table.this.arn
}

output "stream_arn" {
  value = aws_dynamodb_table.this.stream_arn
}

output "point_in_time_recovery_enabled" {
  value = aws_dynamodb_table.this.point_in_time_recovery[0].enabled
}

output "deletion_protection_enabled" {
  value = aws_dynamodb_table.this.deletion_protection_enabled
}

output "billing_mode" {
  value = aws_dynamodb_table.this.billing_mode
}
