output "queue_arn" {
  value = aws_sqs_queue.this.arn
}

output "queue_url" {
  value = aws_sqs_queue.this.id
}

output "queue_name" {
  value = aws_sqs_queue.this.name
}

output "dlq_arn" {
  value = aws_sqs_queue.dlq.arn
}

output "dlq_name" {
  value = aws_sqs_queue.dlq.name
}

output "policy_id" {
  description = "Queue policy id (depend on it before creating the S3 notification)."
  value       = try(aws_sqs_queue_policy.s3_source[0].id, null)
}
