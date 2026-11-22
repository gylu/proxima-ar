#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  echo 'Usage: sh scripts/deploy-public.sh PROJECT_ID REGION PAGES_HTTPS_ORIGIN' >&2
  exit 2
fi
project_id=$1
region=$2
pages_origin=$3
cd "$(dirname "$0")/.."
gateway_account="proxima-public@$project_id.iam.gserviceaccount.com"
build_account="projects/$project_id/serviceAccounts/proxima-build@$project_id.iam.gserviceaccount.com"
quota_bucket="$project_id-public-usage"
service_url=$(gcloud run services describe proxima-guide --project="$project_id" --region="$region" --format='value(status.url)')
test -n "$service_url"
if ! gcloud iam service-accounts describe "$gateway_account" --project="$project_id" >/dev/null 2>&1; then
  gcloud iam service-accounts create proxima-public --project="$project_id" --display-name='Proxima public gateway'
fi
if ! gcloud storage buckets describe "gs://$quota_bucket" --project="$project_id" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$quota_bucket" --project="$project_id" --location="$region" \
    --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0
fi
gcloud storage buckets add-iam-policy-binding "gs://$quota_bucket" --project="$project_id" \
  --member="serviceAccount:$gateway_account" --role=roles/storage.objectUser --quiet >/dev/null
gcloud secrets add-iam-policy-binding proxima-service-token --project="$project_id" \
  --member="serviceAccount:$gateway_account" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
gcloud run services add-iam-policy-binding proxima-guide --region="$region" --project="$project_id" \
  --member="serviceAccount:$gateway_account" --role=roles/run.invoker --quiet >/dev/null

# Stage an explicit list so local credentials, camera data and the rest of the repository never enter this image.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/gateway" "$stage/server" "$stage/web"
cp gateway/Dockerfile "$stage/"
cp gateway/*.mjs "$stage/gateway/"
cp server/guidance.mjs server/grounding.mjs server/provider.mjs "$stage/server/"
cp web/models.js "$stage/web/"
cp package.json "$stage/"
gcloud run deploy proxima-public --project="$project_id" --region="$region" --source="$stage" \
  --service-account="$gateway_account" --build-service-account="$build_account" \
  --set-env-vars="PROXIMA_PAGES_ORIGIN=$pages_origin,PROXIMA_QUOTA_BUCKET=$quota_bucket,PROXIMA_SERVICE_URL=$service_url" \
  --set-secrets='PROXIMA_SERVICE_TOKEN=proxima-service-token:latest' \
  --min=0 --max=1 --max-instances=1 --session-affinity --concurrency=12 --cpu=1 --memory=512Mi \
  --timeout=180s --cpu-throttling --execution-environment=gen2 --quiet
