output "api_id" {
  value = aws_apigatewayv2_api.this.id
}

output "api_url" {
  value = aws_apigatewayv2_api.this.api_endpoint
}

output "access_log_group_name" {
  value = aws_cloudwatch_log_group.access.name
}

output "route_throttles" {
  value = var.route_throttles
}
