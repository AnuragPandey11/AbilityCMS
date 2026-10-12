#!/usr/bin/env bash
#
# Releases one backend image to the app server: the database migrations first,
# then the five processes. The release workflow runs this; it also runs by hand:
#
#     bash deploy/aws/release.sh <full image address>
#
# The settings every process shares are in settings.json, beside this file.
set -euo pipefail

IMAGE="$1"
CLUSTER="solarcms"
SERVICE="solarcms-app"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"

# A task definition with this image, the shared settings and logging added to
# every container in it.
register() {
  jq --arg image "$IMAGE" --slurpfile shared "$HERE/settings.json" '
    .containerDefinitions |= map(. + {
      image: $image,
      environment: $shared[0].environment,
      secrets: $shared[0].secrets,
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": "/solarcms/app",
          "awslogs-region": "ap-south-1",
          "awslogs-stream-prefix": .name
        }
      }
    })' "$HERE/$1" > "$WORK/$1"
  aws ecs register-task-definition --cli-input-json "file://$WORK/$1" \
    --query 'taskDefinition.taskDefinitionArn' --output text
}

MIGRATE="$(register task-migrate.json)"
APP="$(register task-app.json)"

echo "Running the database migrations ($MIGRATE)"
TASK="$(aws ecs run-task --cluster "$CLUSTER" --launch-type EC2 \
  --task-definition "$MIGRATE" --query 'tasks[0].taskArn' --output text)"
if [ -z "$TASK" ] || [ "$TASK" = "None" ]; then
  echo "The migration task did not start. Is the app server in the cluster, with memory free?"
  exit 1
fi
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
if [ "$CODE" != "0" ]; then
  echo "The migrations failed (exit code $CODE), so nothing was released."
  echo "Their log is in CloudWatch: log group /solarcms/app, streams starting migrate/."
  exit 1
fi

ACTIVE="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[?status==`ACTIVE`].serviceName' --output text)"
if [ "$ACTIVE" = "$SERVICE" ]; then
  echo "Updating $SERVICE to $APP"
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
    --task-definition "$APP" > /dev/null
else
  echo "Creating $SERVICE with $APP"
  aws ecs create-service --cluster "$CLUSTER" --service-name "$SERVICE" \
    --task-definition "$APP" --desired-count 1 --launch-type EC2 \
    --deployment-configuration '{"minimumHealthyPercent":0,"maximumPercent":100,"deploymentCircuitBreaker":{"enable":true,"rollback":true}}' \
    > /dev/null
fi

echo "Waiting for the new version to be running and healthy"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
echo "Released $IMAGE"
