# User-facing alerts: one SNS topic, one email subscription per user with a
# filter policy on user_id (created by the API when the user saves an email).
# Weekly digest: EventBridge Scheduler invokes the digest function.

resource "aws_sns_topic" "alerts" {
  name              = "${var.name}-alerts"
  kms_master_key_id = "alias/aws/sns"
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  count              = var.enable_digest ? 1 : 0
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  count = var.enable_digest ? 1 : 0
  name  = "invoke-digest"
  role  = aws_iam_role.scheduler[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = var.digest_function_arn
    }]
  })
}

resource "aws_scheduler_schedule" "digest" {
  count                        = var.enable_digest ? 1 : 0
  name                         = "${var.name}-weekly-digest"
  schedule_expression          = var.digest_schedule
  schedule_expression_timezone = var.digest_timezone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.digest_function_arn
    role_arn = aws_iam_role.scheduler[0].arn
    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}
