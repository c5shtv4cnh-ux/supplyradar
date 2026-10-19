output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "digest_schedule_name" {
  value = try(aws_scheduler_schedule.digest[0].name, null)
}
