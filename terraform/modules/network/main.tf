# VPC for the data function: two private subnets, no internet route and
# no NAT gateway (which would cost ~$32/month). S3 and DynamoDB are reached
# through free gateway endpoints.

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.name}-vpc" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.cidr_block, 8, count.index + 1)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${var.name}-private-${count.index + 1}" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "gateway" {
  for_each          = toset(["s3", "dynamodb"])
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = { Name = "${var.name}-${each.key}-endpoint" }
}

# The default security group allows nothing.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.this.id
}

# Lambda SG: no inbound, outbound HTTPS only to the S3 and DynamoDB endpoints.
resource "aws_security_group" "lambda" {
  name        = "${var.name}-lambda"
  description = "Validate Lambda: HTTPS to S3 and DynamoDB gateway endpoints only"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-lambda" }
}

resource "aws_vpc_security_group_egress_rule" "endpoints" {
  for_each          = aws_vpc_endpoint.gateway
  security_group_id = aws_security_group.lambda.id
  description       = "HTTPS to ${each.key}"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = each.value.prefix_list_id
}
