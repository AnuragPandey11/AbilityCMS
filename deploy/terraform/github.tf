# GitHub's workflows prove who they are with OIDC and receive short-lived AWS
# permissions, so no AWS key is ever stored in GitHub. Each role trusts exactly
# one kind of run of this repository.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  github_runs = {
    deploy          = ["repo:${var.github_repo}:environment:production"]
    terraform_plan  = ["repo:${var.github_repo}:pull_request", "repo:${var.github_repo}:ref:refs/heads/main"]
    terraform_apply = ["repo:${var.github_repo}:environment:infrastructure"]
  }
  github_trust = {
    for name, runs in local.github_runs : name => jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect    = "Allow"
        Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
        Action    = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals           = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
          StringEqualsIgnoreCase = { "token.actions.githubusercontent.com:sub" = runs }
        }
      }]
    })
  }
}

# Releases the backend (deploy-backend.yml): stores images, runs the migration
# task, updates the app service, and hands the two app roles to ECS.
resource "aws_iam_role" "github_deploy" {
  name               = "solarcms-github-deploy"
  assume_role_policy = local.github_trust.deploy
}

resource "aws_iam_role_policy" "github_release" {
  name = "solarcms-release"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LogInToTheImageStore", Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      {
        Sid    = "StoreImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
          "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
        ]
        Resource = aws_ecr_repository.backend.arn
      },
      {
        Sid    = "Release"
        Effect = "Allow"
        Action = [
          "ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:RunTask", "ecs:DescribeTasks",
          "ecs:DescribeServices", "ecs:CreateService", "ecs:UpdateService",
        ]
        Resource = "*"
      },
      { Sid = "HandTheAppRolesToECS", Effect = "Allow", Action = "iam:PassRole", Resource = [aws_iam_role.task_execution.arn, aws_iam_role.task.arn] },
    ]
  })
}

# Plans Terraform changes (terraform.yml) for pull requests and for main. It may
# read every setting, but never a backup, a report file, a log line or a secret.
resource "aws_iam_role" "github_terraform_plan" {
  name               = "solarcms-github-terraform-plan"
  assume_role_policy = local.github_trust.terraform_plan
}

resource "aws_iam_role_policy" "github_terraform_plan_limits" {
  name = "never-read-data-or-secrets"
  role = aws_iam_role.github_terraform_plan.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "NoBackupsOrReports", Effect = "Deny", Action = "s3:GetObject*", Resource = ["${aws_s3_bucket.backups.arn}/*", "${aws_s3_bucket.reports.arn}/*"] },
      { Sid = "NoSecrets", Effect = "Deny", Action = "ssm:GetParameter*", Resource = "arn:aws:ssm:*:${local.account_id}:parameter/solarcms/*" },
      { Sid = "NoLogLines", Effect = "Deny", Action = ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:StartLiveTail"], Resource = "*" },
    ]
  })
}

# Applies Terraform changes merged into main (terraform.yml, environment
# "infrastructure"). It manages roles, including its own, so a narrower policy
# could be widened by a change it applies; what protects it is who can run it:
# only main, only after the pull request's plan was read and merged.
resource "aws_iam_role" "github_terraform_apply" {
  name               = "solarcms-github-terraform-apply"
  assume_role_policy = local.github_trust.terraform_apply
}
