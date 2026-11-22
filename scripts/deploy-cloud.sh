#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then
  echo 'Usage: sh scripts/deploy-cloud.sh PROJECT_ID REGION' >&2
  exit 2
fi
project_id=$1
region=$2
cd "$(dirname "$0")/.."
gcloud run deploy proxima-guide \
  --project="$project_id" --region="$region" --source=. \
  --service-account="proxima-runtime@$project_id.iam.gserviceaccount.com" \
  --build-service-account="projects/$project_id/serviceAccounts/proxima-build@$project_id.iam.gserviceaccount.com" \
  --set-secrets='CEREBRAS_API_KEY=proxima-cerebras:latest,PROXIMA_SERVICE_TOKEN=proxima-service-token:latest' \
  --no-allow-unauthenticated --invoker-iam-check --execution-environment=gen2 \
  --min=0 --max=1 --max-instances=1 --session-affinity --concurrency=4 --cpu=2 --memory=2Gi --timeout=180s --quiet
