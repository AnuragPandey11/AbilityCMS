resource "aws_ecs_cluster" "main" {
  name = "solarcms"
}

# Every process writes its log lines here, kept for 30 days.
resource "aws_cloudwatch_log_group" "app" {
  name              = "/solarcms/app"
  retention_in_days = 30
}

# Each built version of the backend image, scanned when stored; the last 15 are kept.
resource "aws_ecr_repository" "backend" {
  name = "solarcms-backend"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 15 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 15 }
      action       = { type = "expire" }
    }]
  })
}

# Redis and the HTTPS front door, read from the files in deploy/aws/. The app's
# own service and its two task definitions (solarcms-app, solarcms-migrate)
# belong to the release script and are never created here.
locals {
  support_tasks = {
    redis = jsondecode(file("${path.module}/../aws/task-redis.json"))
    proxy = jsondecode(file("${path.module}/../aws/task-proxy.json"))
  }
}

resource "aws_ecs_task_definition" "support" {
  for_each                 = local.support_tasks
  family                   = each.value.family
  network_mode             = each.value.networkMode
  requires_compatibilities = each.value.requiresCompatibilities
  execution_role_arn       = aws_iam_role.task_execution.arn
  container_definitions    = jsonencode(each.value.containerDefinitions)

  runtime_platform {
    cpu_architecture        = each.value.runtimePlatform.cpuArchitecture
    operating_system_family = each.value.runtimePlatform.operatingSystemFamily
  }

  dynamic "volume" {
    for_each = each.value.volumes
    content {
      name      = volume.value.name
      host_path = volume.value.host.sourcePath
    }
  }
}

resource "aws_ecs_service" "support" {
  for_each                           = aws_ecs_task_definition.support
  name                               = "solarcms-${each.key}"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = each.value.arn
  desired_count                      = 1
  launch_type                        = "EC2"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
}
