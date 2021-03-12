# Zalando postgresql operator test

## Description

Zalando postgresql operator test bootstraps:

- postgesql operator
- replicated postgresql instance
- precreates users and databases

## Operations

- Connecting to database as admin user

```
PGSSLROOTCERT=<(pulumi stack output --show-secrets caCert) PGSSLMODE=verify-full \
PGPASSWORD=$(pulumi stack output  --show-secrets postgresPassword) \
    psql -h $(pulumi stack output  --show-secrets host) -Upostgres
```

- Connecting to database as user

```
PGSSLROOTCERT=<(pulumi stack output --show-secrets caCert) PGSSLMODE=verify-full \
PGPASSWORD=$(pulumi stack output  --show-secrets password) \
    psql -h $(pulumi stack output  --show-secrets host) -U$(pulumi stack output  --show-secrets username) $(pulumi stack output db)
```