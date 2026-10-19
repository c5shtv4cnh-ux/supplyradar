output "vpc_id" {
  value = aws_vpc.this.id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "lambda_security_group_id" {
  value = aws_security_group.lambda.id
}

output "gateway_endpoint_ids" {
  value = { for k, v in aws_vpc_endpoint.gateway : k => v.id }
}
