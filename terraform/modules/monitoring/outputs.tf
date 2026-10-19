output "ops_topic_arn" {
  value = aws_sns_topic.ops.arn
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.this.dashboard_name
}
