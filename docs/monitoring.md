# Monitoring

Everything below is created by `terraform/modules/monitoring` and the `lambda_function` module.
It is sized to the CloudWatch free tier: exactly 10 alarms, 3 custom metrics, 1 dashboard.

## What is collected

| Signal | Where | Retention |
|---|---|---|
| Function logs (api, extract, validate, notify, digest) | CloudWatch Logs `/aws/lambda/supplyradar-<env>-<fn>` | 7 days (30 in prod) |
| API access log (route, status, latency, auth error) | `/aws/apigateway/supplyradar-<env>` | 7 days (30 in prod) |
| Built-in metrics | Lambda, SQS, API Gateway, DynamoDB, CloudFront, WAF | 15 months |
| Metrics made from logs | namespace `SupplyRadar/supplyradar-<env>`: `LoggedErrors`, `InvoicesChecked`, `InvoicesNeedsReview` | 15 months |
| Traces | X-Ray, every function (`enable_xray`) | 30 days |

## One dashboard

`terraform output dashboard_url` opens the dashboard `supplyradar-<env>`. Top to bottom it follows a request:

| Row | Widgets | The question it answers |
|---|---|---|
| Alarms | status of all 10 alarms | is anything wrong right now? |
| API | requests with 4xx / 5xx; latency p50, p95 and time inside Lambda | are users served, and how fast? |
| Lambda | invocations; errors, logged errors and throttles; duration p95 | which function is slow or failing? |
| Pipeline | waiting messages; age of the oldest message; invoices checked vs needing review | is the invoice pipeline moving, and how good is the AI today? |
| Data and edge | DynamoDB consumed capacity and throttles; CloudFront requests and error rate; WAF allowed / blocked | are we near a capacity limit, is someone attacking? |
| Logs | the 20 most recent error lines from all functions | what exactly failed? |

For the demo: upload an invoice and watch API → Lambda → queues → "invoices checked" move left to right.

## Alarms (email to `alarm_email` through the ops SNS topic)

| # | Alarm | Fires when | Usually means |
|---|---|---|---|
| 1–5 | `supplyradar-<env>-<fn>-errors` | a function crashed at least once in 5 minutes | unhandled exception, timeout, out of memory |
| 6 | `supplyradar-<env>-dlq-not-empty` | a message reached a dead-letter queue | an invoice failed 3 times (unreadable file, Gemini down or out of quota, a bug in validation) |
| 7 | `supplyradar-<env>-queue-backlog` | the oldest waiting message is older than 15 minutes, twice in a row | the pipeline is stuck: Gemini quota, a disabled trigger, throttling |
| 8 | `supplyradar-<env>-api-5xx` | 5 or more 5xx responses in 5 minutes | the api function or a dependency is failing |
| 9 | `supplyradar-<env>-lambda-throttles` | any function was throttled | the account concurrency limit was reached |
| 10 | `supplyradar-<env>-logged-errors` | 3 or more error lines in the logs in 5 minutes | failures the functions caught themselves (see below) |

Alarms also send an OK message when they recover. Two environments in one account make 20 alarms:
the second ten cost $0.10 each per month.

**Why alarm 10 exists.** The queue workers catch their own exceptions so that one bad message does not
fail a whole batch. That is right for the pipeline, but it hides the failure from the built-in Lambda
`Errors` metric. A log metric filter on every function's log group counts `[ERROR]` lines and timeouts
into the `LoggedErrors` metric instead, so a Gemini outage is noticed after three failed attempts, not
only when messages reach the dead-letter queue.

## X-Ray tracing

`enable_xray = true` (default) turns on active tracing for the five functions. Open
`terraform output xray_trace_map_url` to see the service map and, per invocation, how long the cold
start and the handler took. An upload can be followed from the extract function through SQS to the
validate function, because Lambda carries the trace header across the queue.

- Cost: the first 100 000 traces a month are free, then $5 per million. X-Ray samples the first
  request each second and 5 % of the rest, so the demo stays far below the free amount.
- Limit: the functions use only the standard library, so traces show Lambda's own segments
  (queue wait, initialisation, invocation), not one sub-segment per DynamoDB or Gemini call. Adding the
  AWS X-Ray SDK or an OpenTelemetry layer would give that detail.
- API Gateway HTTP APIs do not emit X-Ray segments; API latency is on the dashboard instead.

## Saved log queries

CloudWatch → Logs Insights → Saved queries → folder `supplyradar-<env>`:

| Query | Use |
|---|---|
| Recent errors in all functions | first stop after an alarm email |
| API latency and errors by route | which route is slow, which returns errors |
| Cold starts and memory by function | is the memory size right, how often do cold starts happen |

## Backups and restore

| Data | Protection | Restore |
|---|---|---|
| DynamoDB table | point-in-time recovery, any second of the last 35 days (`enable_point_in_time_recovery`, on) | command below |
| Invoice originals | 90 days in S3 (365 in prod), Standard-IA after 30 days; versioning in prod keeps deleted files 30 days | S3 console → Show versions |
| Web app files | previous versions kept 30 days | S3 console → Show versions, or redeploy an older commit |
| Terraform state | versioned bucket, old versions kept 90 days | S3 console → Show versions |
| Users | Cognito (managed by AWS); deletion protection in prod | — |

Restore the table as it was at a moment in time (creates a new table next to the old one):

```bash
aws dynamodb restore-table-to-point-in-time \
  --source-table-name supplyradar-dev --target-table-name supplyradar-dev-restored \
  --restore-date-time 2026-11-15T09:00:00Z
```

Check the restored table, then either copy the lost items back or point the stack at it.
Recovery point objective: seconds. Recovery time: 10–30 minutes for a table of this size.

## Budget

`supplyradar-<env>-monthly`: $1 in dev ($15 in prod, where WAF and KMS are on); email at 50 % of
actual spend and at 100 % of forecast.

## Useful commands

```bash
# live logs of one function
aws logs tail /aws/lambda/supplyradar-dev-extract --follow

# errors in the last hour
aws logs filter-log-events --log-group-name /aws/lambda/supplyradar-dev-validate \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) --filter-pattern ERROR

# state of every alarm
aws cloudwatch describe-alarms --alarm-name-prefix supplyradar-dev \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output table

# queue depth
aws sqs get-queue-attributes --queue-url $(aws sqs get-queue-url --queue-name supplyradar-dev-extract-dlq --query QueueUrl --output text) \
  --attribute-names ApproximateNumberOfMessages

# replay failed messages from a DLQ back to its queue (after fixing the cause)
aws sqs start-message-move-task \
  --source-arn arn:aws:sqs:eu-central-1:<account>:supplyradar-dev-extract-dlq

# is the deployed site healthy?
make smoke
```

## AI quality monitoring

- `tests/eval/run_eval.py` measures field accuracy on the 12 synthetic invoices; run it when changing
  the prompt or the model (`gemini_model`).
- Live signal: the dashboard widget *invoices checked vs needing review*. Every invoice that needs
  review is a case where the model or the document was wrong; a rising share after a model change
  means the change made things worse.
