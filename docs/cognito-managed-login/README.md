# Elettro OS sign-in page (Cognito managed login)

The sign-in screen at `us-east-1ydbehb7ps.auth.us-east-1.amazoncognito.com` is AWS's managed login. It is styled here to match os.elettro.com:
navy page, panel form, cyan buttons, the Elettro wordmark on the form, the Elettro icon as favicon.

- `settings.json`: the branding settings (defaults from Cognito, with the Elettro colours and the form logo switched on).
- `assets.json`: the form logo (public/brand/elettro-logo-white.png) and favicon, base64.

User pool `us-east-1_YDBehB7ps` (User pool - e4j1dk), app client `34u0cdg0b3tl2mv6qti19e09oq`, branding id `3a299062-e6cb-4998-85b9-b7a6a9863f2b`.
The `stashbox-audit` profile cannot change this; run it with a profile that can (root, or the console's Branding editor).

```
aws cognito-idp update-managed-login-branding --user-pool-id us-east-1_YDBehB7ps \
  --managed-login-branding-id 3a299062-e6cb-4998-85b9-b7a6a9863f2b \
  --settings file://docs/cognito-managed-login/settings.json \
  --assets file://docs/cognito-managed-login/assets.json --profile elettro
```

To undo: `--use-cognito-provided-values` on the same command returns it to the defaults.
