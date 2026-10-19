# Operations: alarms on function errors and dead-letter queues, a dashboard,
# and a monthly $1 budget. Alarms email the project owner through an ops topic.

data "aws_region" "current" {}

resource "aws_sns_topic" "ops" {
  name = "${var.name}-ops"
}

resource "aws_sns_topic_subscription" "ops_email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.ops.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = toset(var.function_names)
  alarm_name          = "${each.value}-errors"
  alarm_description   = "Lambda ${each.value} reported errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "dlq" {
  for_each            = toset(var.dlq_names)
  alarm_name          = "${each.value}-not-empty"
  alarm_description   = "Messages in ${each.value}: processing failed after all retries"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title   = "Lambda invocations"
          region  = data.aws_region.current.region
          stat    = "Sum"
          period  = 300
          metrics = [for f in var.function_names : ["AWS/Lambda", "Invocations", "FunctionName", f]]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title   = "Lambda errors"
          region  = data.aws_region.current.region
          stat    = "Sum"
          period  = 300
          metrics = [for f in var.function_names : ["AWS/Lambda", "Errors", "FunctionName", f]]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title   = "Lambda duration (p95, ms)"
          region  = data.aws_region.current.region
          stat    = "p95"
          period  = 300
          metrics = [for f in var.function_names : ["AWS/Lambda", "Duration", "FunctionName", f]]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title   = "Queues: waiting messages"
          region  = data.aws_region.current.region
          stat    = "Maximum"
          period  = 300
          metrics = [for q in concat(var.queue_names, var.dlq_names) : ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", q]]
        }
      },
      {
        type = "metric", x = 0, y = 12, width = 12, height = 6
        properties = {
          title  = "API requests and errors"
          region = data.aws_region.current.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", var.api_id],
            ["AWS/ApiGateway", "4xx", "ApiId", var.api_id],
            ["AWS/ApiGateway", "5xx", "ApiId", var.api_id],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 12, width = 12, height = 6
        properties = {
          title  = "DynamoDB consumed capacity"
          region = data.aws_region.current.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", var.table_name],
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", var.table_name],
          ]
        }
      },
    ]
  })
}

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_limit_usd > 0 && var.alarm_email != "" ? 1 : 0
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alarm_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alarm_email]
  }
}
