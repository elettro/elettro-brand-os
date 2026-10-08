# Elettro Brand OS DEV API Lambda

This Lambda is the first authenticated database connectivity test for the DEV backend.

## Required Lambda environment variables

- `DB_SECRET_NAME=elettro-brand-os-dev/rds`
- `DB_HOST=<RDS endpoint>`

## Required IAM

The execution role must allow:

- `secretsmanager:GetSecretValue` for the DEV RDS secret
- VPC ENI permissions via `AWSLambdaVPCAccessExecutionRole`

## Networking

The function must be attached to the same VPC as the RDS instance and have:

- Lambda-to-RDS TCP 5432 access
- private Secrets Manager access through the DEV Secrets Manager interface endpoint

## Build deployment package

From this directory:

```bash
npm ci --omit=dev
zip -r elettro-brand-os-dev-api.zip index.mjs node_modules package.json
```

Upload the resulting ZIP to the existing Lambda function:

`elettro-brand-os-dev-api`

The handler remains:

`index.handler`

## Expected test result

A successful Lambda test returns HTTP-style JSON whose body contains:

```json
{
  "ok": true,
  "message": "Authenticated PostgreSQL connection succeeded",
  "result": {
    "ok": 1
  }
}
```

No database password is logged or returned.
