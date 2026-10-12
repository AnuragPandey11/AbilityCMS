resource "aws_sns_topic" "alerts" {
  name = "solarcms-alerts"
}

# Each address receives an email asking to confirm; nothing arrives until it is confirmed.
resource "aws_sns_topic_subscription" "alerts" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  data_id = aws_instance.data.id
  app_id  = aws_instance.app.id

  # The eight server alarms. The disk and memory figures come from the CloudWatch
  # agent (step 11.2): Ubuntu's disks are ext4, Amazon Linux's system disk is xfs.
  server_alarms = {
    solarcms-data-disk        = { namespace = "SolarCMS", metric = "disk_used_percent", dims = tomap({ InstanceId = local.data_id, path = "/var/lib/postgresql", fstype = "ext4" }), stat = "Maximum", period = 300, above = 80, of = 1 }
    solarcms-data-system-disk = { namespace = "SolarCMS", metric = "disk_used_percent", dims = tomap({ InstanceId = local.data_id, path = "/", fstype = "ext4" }), stat = "Maximum", period = 300, above = 85, of = 1 }
    solarcms-app-disk         = { namespace = "SolarCMS", metric = "disk_used_percent", dims = tomap({ InstanceId = local.app_id, path = "/", fstype = "xfs" }), stat = "Maximum", period = 300, above = 85, of = 1 }
    solarcms-data-memory      = { namespace = "SolarCMS", metric = "mem_used_percent", dims = tomap({ InstanceId = local.data_id }), stat = "Average", period = 300, above = 90, of = 3 }
    solarcms-data-cpu         = { namespace = "AWS/EC2", metric = "CPUUtilization", dims = tomap({ InstanceId = local.data_id }), stat = "Average", period = 300, above = 80, of = 3 }
    solarcms-app-cpu          = { namespace = "AWS/EC2", metric = "CPUUtilization", dims = tomap({ InstanceId = local.app_id }), stat = "Average", period = 300, above = 80, of = 3 }
    solarcms-data-status      = { namespace = "AWS/EC2", metric = "StatusCheckFailed", dims = tomap({ InstanceId = local.data_id }), stat = "Maximum", period = 60, above = 0, of = 2 }
    solarcms-app-status       = { namespace = "AWS/EC2", metric = "StatusCheckFailed", dims = tomap({ InstanceId = local.app_id }), stat = "Maximum", period = 60, above = 0, of = 2 }
  }
}

resource "aws_cloudwatch_metric_alarm" "server" {
  for_each            = local.server_alarms
  alarm_name          = each.key
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dims
  statistic           = each.value.stat
  period              = each.value.period
  evaluation_periods  = each.value.of
  datapoints_to_alarm = each.value.of
  threshold           = each.value.above
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# The two public doors, called from outside every 30 seconds. They stay switched
# off (always "healthy") until both answer; step 11.4 switches them on.
resource "aws_route53_health_check" "outside" {
  for_each = {
    api    = { fqdn = "api.${var.domain}", type = "HTTPS", port = 443, path = "/healthz" }
    broker = { fqdn = "mqtt.${var.domain}", type = "TCP", port = 8883, path = null }
  }
  fqdn              = each.value.fqdn
  type              = each.value.type
  port              = each.value.port
  resource_path     = each.value.path
  request_interval  = 30
  failure_threshold = 3
  disabled          = !var.outside_checks
  tags              = { Name = "solarcms-${each.key}" }
}

resource "aws_sns_topic" "alerts_outside" {
  provider = aws.us_east_1
  name     = "solarcms-alerts-outside"
}

resource "aws_sns_topic_subscription" "alerts_outside" {
  provider  = aws.us_east_1
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts_outside.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_metric_alarm" "outside" {
  provider            = aws.us_east_1
  for_each            = aws_route53_health_check.outside
  alarm_name          = "solarcms-${each.key}-unreachable"
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = each.value.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts_outside.arn]
}

# Security updates every Monday 03:00 India time. The app server may restart for
# them (the broker holds readings meanwhile); the data server never restarts by
# itself, because nothing can be received while it does (step 14.4).
resource "aws_ssm_association" "patching" {
  for_each                    = { app = "RebootIfNeeded", data = "NoReboot" }
  association_name            = "solarcms-${each.key}-patching"
  name                        = "AWS-RunPatchBaseline"
  schedule_expression         = "cron(30 21 ? * SUN *)"
  apply_only_at_cron_interval = true
  parameters = {
    Operation    = "Install"
    RebootOption = each.value
  }
  targets {
    key    = "tag:Role"
    values = [each.key]
  }
}
