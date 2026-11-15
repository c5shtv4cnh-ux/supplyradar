output "role_arn" {
  description = "Plan role: put it in the GitHub repository variable AWS_PLAN_ROLE_ARN (AWS_PLAN_ROLE_ARN_PROD for prod)."
  value       = aws_iam_role.plan.arn
}

output "deploy_role_arn" {
  description = "Deploy role: GitHub repository variable AWS_DEPLOY_ROLE_ARN (AWS_DEPLOY_ROLE_ARN_PROD for prod)."
  value       = try(aws_iam_role.deploy[0].arn, null)
}

output "deploy_role_name" {
  value = try(aws_iam_role.deploy[0].name, null)
}

output "creates_oidc_provider" {
  value = var.create_oidc_provider
}
