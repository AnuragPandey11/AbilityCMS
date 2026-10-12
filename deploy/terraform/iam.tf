locals {
  trust = {
    for name, service in { ec2 = "ec2.amazonaws.com", ecs_tasks = "ecs-tasks.amazonaws.com" } :
    name => jsonencode({
      Version   = "2012-10-17"
      Statement = [{ Effect = "Allow", Principal = { Service = service }, Action = "sts:AssumeRole" }]
    })
  }
}

# Data server: the backups bucket, Session Manager terminals, CloudWatch figures.
resource "aws_iam_role" "data_server" {
  name               = "solarcms-data-server"
  assume_role_policy = local.trust.ec2
}

resource "aws_iam_role_policy" "data_server_backups" {
  name = "solarcms-backups"
  role = aws_iam_role.data_server.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:ListBucket", Resource = aws_s3_bucket.backups.arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.backups.arn}/*" },
    ]
  })
}

resource "aws_iam_instance_profile" "data" {
  name = "solarcms-data-server"
  role = aws_iam_role.data_server.name
}

# App server: joins the ECS cluster, Session Manager terminals, CloudWatch figures.
resource "aws_iam_role" "app_server" {
  name               = "solarcms-app-server"
  assume_role_policy = local.trust.ec2
}

resource "aws_iam_instance_profile" "app" {
  name = "solarcms-app-server"
  role = aws_iam_role.app_server.name
}

# What ECS itself uses to start a container: fetch the image, write logs, read the six secrets.
resource "aws_iam_role" "task_execution" {
  name               = "solarcms-task-execution"
  assume_role_policy = local.trust.ecs_tasks
}

resource "aws_iam_role_policy" "task_execution_parameters" {
  name = "read-solarcms-parameters"
  role = aws_iam_role.task_execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "ssm:GetParameters", Resource = "arn:aws:ssm:ap-south-1:${local.account_id}:parameter/solarcms/prod/*" }]
  })
}

# What the running app may do: write and read report files.
resource "aws_iam_role" "task" {
  name               = "solarcms-task"
  assume_role_policy = local.trust.ecs_tasks
}

resource "aws_iam_role_policy" "task_reports" {
  name = "solarcms-reports"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = "${aws_s3_bucket.reports.arn}/*" }]
  })
}

locals {
  aws_managed = "arn:aws:iam::aws:policy"
  managed_policies = {
    data_ssm            = { role = aws_iam_role.data_server.name, policy = "${local.aws_managed}/AmazonSSMManagedInstanceCore" }
    data_cloudwatch     = { role = aws_iam_role.data_server.name, policy = "${local.aws_managed}/CloudWatchAgentServerPolicy" }
    app_ecs             = { role = aws_iam_role.app_server.name, policy = "${local.aws_managed}/service-role/AmazonEC2ContainerServiceforEC2Role" }
    app_ssm             = { role = aws_iam_role.app_server.name, policy = "${local.aws_managed}/AmazonSSMManagedInstanceCore" }
    app_cloudwatch      = { role = aws_iam_role.app_server.name, policy = "${local.aws_managed}/CloudWatchAgentServerPolicy" }
    task_execution      = { role = aws_iam_role.task_execution.name, policy = "${local.aws_managed}/service-role/AmazonECSTaskExecutionRolePolicy" }
    github_tf_plan_read = { role = aws_iam_role.github_terraform_plan.name, policy = "${local.aws_managed}/ReadOnlyAccess" }
    github_tf_apply     = { role = aws_iam_role.github_terraform_apply.name, policy = "${local.aws_managed}/AdministratorAccess" }
  }
}

resource "aws_iam_role_policy_attachment" "managed" {
  for_each   = local.managed_policies
  role       = each.value.role
  policy_arn = each.value.policy
}
