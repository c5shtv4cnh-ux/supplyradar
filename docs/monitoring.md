# Monitoring

Everything below is created by `terraform/modules/monitoring` and the `lambda_function` module.

## What is collected

| Signal | Where | Retention |
|---|---|---|
| Function logs (api, extract, validate, notify, digest) | CloudWatch Logs `/aws/lambda/supplyradar-<env>-<fn>` | 7 days (14 in prod) |
| API access log (route, status, latency, auth error) | `/aws/apigateway/supplyradar-<env>` | 7 days |
| Metrics | Lambda, SQS, API Gateway, DynamoDB built-in metrics | 15 months |

## Alarms (email to `alarm_email` through the ops SNS topic)

| Alarm | Fires when | Usually means |
|---|---|---|
| `supplyradar-<env>-<fn>-errors` × 5 | ≥ 1 error in 5 minutes | a bug or a failing dependency (Gemini, quota) |
| `supplyradar-<env>-extract-dlq-not-empty` | a message reached the extract DLQ | an invoice failed 3 times (unreadable file, Gemini down or out of quota) |
| `supplyradar-<env>-validate-dlq-not-empty` | a message reached the validate DLQ | unexpected data or a code bug in validation |

Alarms also send an OK message when they recover.

## Dashboard

`terraform output dashboard_url` opens a dashboard with six widgets: Lambda invocations, errors,
p95 duration, waiting messages in all queues and DLQs, API requests with 4xx/5xx, and DynamoDB consumed capacity.

## Budget

`supplyradar-<env>-monthly`: $1 limit; email at 50 % of actual spend and at 100 % of forecast.

## Useful commands

```bash
# live logs of one function
aws logs tail /aws/lambda/supplyradar-dev-extract --follow

# errors in the last hour
aws logs filter-log-events --log-group-name /aws/lambda/supplyradar-dev-validate \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) --filter-pattern ERROR

# queue depth
aws sqs get-queue-attributes --queue-url $(aws sqs get-queue-url --queue-name supplyradar-dev-extract-dlq --query QueueUrl --output text) \
  --attribute-names ApproximateNumberOfMessages

# replay failed messages from a DLQ back to its queue (after fixing the cause)
aws sqs start-message-move-task \
  --source-arn arn:aws:sqs:eu-central-1:<account>:supplyradar-dev-extract-dlq
```

## AI quality monitoring

- `tests/eval/run_eval.py` measures field accuracy on the 12 synthetic invoices; run it when changing
  the prompt or the model (`gemini_model`).
- In production the share of invoices that end in `needs_review` is the live quality signal: every
  correction a user makes is a case where the model or the document was wrong.
