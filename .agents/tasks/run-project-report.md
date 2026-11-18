# Run project report

Scope: start the Layer 3 web app (schema_chatbot_v2 FastAPI) locally using the credentials in `.env2`.

## Status

Running. Health, main page, and docs all return HTTP 200.

| Item | Value |
| --- | --- |
| URL | http://127.0.0.1:8000 |
| Health | http://127.0.0.1:8000/health (200) |
| Docs | http://127.0.0.1:8000/docs (200) |
| Listener PID | 19060 (uvicorn worker, Python 3.11 system install) |
| Launcher PID | 24468 (`.venv\Scripts\python.exe`, parent of 19060) |
| Stdout log | `.agents\tasks\run-project-server.log` |
| Stderr log | `.agents\tasks\run-project-server.err.log` |

## AWS credentials

- `.env2` provides `aws_access_key_id`, `aws_secret_access_key`, and `aws_session_token`. The session token is present, so these are temporary credentials.
- The keys were mapped to `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` in the server process environment only. `.env2` was not modified, and no values were written to any file or log.
- `AWS_DEFAULT_REGION=ap-south-1`, taken from `BEDROCK_REGION` in `.env`.
- `aws sts get-caller-identity` succeeded:
  - Account: 530084039784
  - ARN: `arn:aws:sts::530084039784:assumed-role/AWSReservedSSO_AdministratorAccess_51be6e17d5334ab5/vinay.k@shellkode.com`
- Temporary credentials expire. Bedrock calls will fail after expiry. Restart the server with fresh `.env2` values when that happens.

## How it was started

No dependencies were installed. The existing `.venv` (Python 3.11.9) already had fastapi 0.141.1, uvicorn 0.52.4, and boto3.

Command (run from `engineer_a\schema_chatbot_v2`, with the `.env2` values loaded into the process environment first):

```powershell
Start-Process -FilePath "c:\Users\Dell\Desktop\IDP\engineer_a\.venv\Scripts\python.exe" `
  -ArgumentList '-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8000' `
  -WorkingDirectory "c:\Users\Dell\Desktop\IDP\engineer_a\schema_chatbot_v2" `
  -RedirectStandardOutput "c:\Users\Dell\Desktop\IDP\engineer_a\.agents\tasks\run-project-server.log" `
  -RedirectStandardError "c:\Users\Dell\Desktop\IDP\engineer_a\.agents\tasks\run-project-server.err.log" `
  -WindowStyle Hidden -PassThru
```

This matches the README "Run the FastAPI Web Application" section. Nothing was deployed to AWS, and no AWS resources were created or changed.

## How to stop

```powershell
Stop-Process -Id 19060,24468 -Force
```

Confirm the port is free afterward with `Get-NetTCPConnection -LocalPort 8000`.

## Warnings from startup (not blocking)

These come from the server's own checks in `.agents\tasks\run-project-server.err.log`:

- `JWT_SECRET` uses an insecure default. Set a secret of at least 32 characters.
- The default admin password `changeme` is in use. Set `ADMIN_PASSWORD`.
- `DATABASE_URL` contains the weak password `12345`.

These are acceptable for local development. Set `APP_ENV=production` or `staging` only after fixing them, because the app then refuses to start.

## Errors

None blocking. The startup log shows "Application startup complete" with no tracebacks.

## Not done

- Tests were not run. The task asked only to start the app.
- No code was modified.
