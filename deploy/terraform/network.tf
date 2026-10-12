data "aws_vpc" "default" {
  default = true
}

data "aws_subnet" "data" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = var.data_zone
  default_for_az    = true
}

data "aws_subnet" "app" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = var.app_zone
  default_for_az    = true
}

resource "aws_security_group" "app" {
  name        = "solarcms-app-sg"
  description = "SolarCMS app server"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "solarcms-app-sg" }
}

resource "aws_security_group" "data" {
  name        = "solarcms-data-sg"
  description = "SolarCMS data server"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "solarcms-data-sg" }
}

locals {
  security_group_ids = {
    app  = aws_security_group.app.id
    data = aws_security_group.data.id
  }

  # Every inbound rule either server has. Neither opens port 22: Session Manager
  # does not need it.
  ingress_from_anywhere = {
    app_http   = { group = "app", port = 80, description = "certificate renewal, redirect to HTTPS" }
    app_https  = { group = "app", port = 443, description = "website and live updates" }
    data_mqtts = { group = "data", port = 8883, description = "Ability publishing, encrypted" }
    data_http  = { group = "data", port = 80, description = "broker certificate renewal" }
  }
  ingress_from_app_server = {
    data_postgres = { port = 5432, description = "app to database" }
    data_mqtt     = { port = 1883, description = "app to broker, private network" }
  }
}

resource "aws_vpc_security_group_ingress_rule" "from_anywhere" {
  for_each          = local.ingress_from_anywhere
  security_group_id = local.security_group_ids[each.value.group]
  description       = each.value.description
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "from_app_server" {
  for_each                     = local.ingress_from_app_server
  security_group_id            = aws_security_group.data.id
  description                  = each.value.description
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  referenced_security_group_id = aws_security_group.app.id
}

# Terraform removes the "all traffic out" rule AWS gives a new group, so it is
# added back: both servers fetch packages, images and certificates.
resource "aws_vpc_security_group_egress_rule" "all_out" {
  for_each          = local.security_group_ids
  security_group_id = each.value
  description       = "all traffic out"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# The two fixed public addresses. DNS points at them, so they outlive any server.
resource "aws_eip" "data" {
  domain = "vpc"
  tags   = { Name = "solarcms-data-ip" }
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_eip" "app" {
  domain = "vpc"
  tags   = { Name = "solarcms-app-ip" }
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_eip_association" "data" {
  allocation_id = aws_eip.data.id
  instance_id   = aws_instance.data.id
}

resource "aws_eip_association" "app" {
  allocation_id = aws_eip.app.id
  instance_id   = aws_instance.app.id
}

# Only when the domain's DNS is in Route 53 (manage_dns = true).
data "aws_route53_zone" "main" {
  count = var.manage_dns ? 1 : 0
  name  = var.domain
}

resource "aws_route53_record" "server" {
  for_each = { for name, ip in { api = aws_eip.app.public_ip, mqtt = aws_eip.data.public_ip } : name => ip if var.manage_dns }
  zone_id  = data.aws_route53_zone.main[0].zone_id
  name     = "${each.key}.${var.domain}"
  type     = "A"
  ttl      = 300
  records  = [each.value]
}
