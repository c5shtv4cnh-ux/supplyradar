# Load test result

- Target: `local fake backend`
- When: 2026-11-15 15:58 UTC
- Scenario: read-only GET mix (/invoices, /products, /alerts, /settings, /savings)
- Note: local stand-in on this computer: it checks the tool and the API code, its numbers say nothing about AWS

| Users | Requests | Served req/s | p50 ms | p95 ms | p99 ms | 429 % | Failed % |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 7048 | 1174.5 | 0.8 | 1.1 | 1.2 | 0.0 | 0.0 |
| 2 | 9454 | 1575.5 | 1.2 | 2.0 | 2.5 | 0.0 | 0.0 |
| 5 | 9562 | 1592.9 | 3.1 | 4.2 | 5.1 | 0.0 | 0.0 |
| 10 | 9885 | 1499.9 | 3.6 | 4.9 | 6.0 | 0.0 | 0.0 |
| 20 | 9762 | 1268.4 | 3.7 | 5.1 | 8.0 | 0.0 | 0.0 |
| 40 | 9775 | 1399.3 | 3.7 | 5.3 | 1023.8 | 0.0 | 0.0 |

- Highest served throughput: **1592.9 req/s** at 5 users (p95 4.2 ms).
- No request was throttled (429).
- Server errors or dropped connections: **0**.
