# BitPro Data Box

Deployment-oriented full-stack portal for authorized dataset processing and result-file management.

## Current implementation

- `index.html`: responsive UI prototype. It currently runs as a standalone frontend; use the backend APIs for real accounts and task persistence.
- `server.js`: Express API with password hashing, JWT sessions, role checks, login rate limiting, file upload validation, user administration, task storage, result downloads, balance ledger and audit logs.
- `db/schema.sql`: PostgreSQL schema and initial product catalog.
- `Dockerfile` / `docker-compose.yml`: container deployment path.
- `admin.html`: intended admin console path; confirm this file exists before deployment. If absent, create it from the admin UI source in the repository.

## Product catalog and price target

The backend seeds eight modules: iOS Status Workflow, iOS Dynamic Status Workflow, TXT File Validation, CSV File Validation, Phone Number Format Audit, Email Format Audit, Duplicate Record Cleanup, and Custom Batch Processing. Target pricing is 4 USDT per 10,000 records for provider-style workflows. File/data quality utilities are free. No payment processor is connected and no real USDT transaction occurs.

## Run with Docker Compose

1. Copy `.env.example` to `.env` and set a strong unique `JWT_SECRET` (at least 32 characters), unique `ADMIN_PASSWORD` (12+ characters), `ADMIN_USERNAME`, and `POSTGRES_PASSWORD`.
2. For local Compose, set `DATABASE_URL=postgresql://bitpro:<POSTGRES_PASSWORD>@db:5432/bitpro_data_box` and `DATABASE_SSL=false` in `.env`.
3. Start: `docker compose up --build -d`.
4. The database schema in `db/schema.sql` is mounted on the initial database creation. If you already have a database volume, apply it manually with `psql "$DATABASE_URL" -f db/schema.sql`.
5. Open `http://localhost:3000`. Admin API is available at `/api`; health check is `/api/health`.

For managed PostgreSQL, set `DATABASE_URL` and `DATABASE_SSL=true` with a valid certificate chain. Do not expose database credentials to the browser.

## Important pre-production checklist

- Run dependency audit and automated API tests; verify auth, file uploads, permissions, balances and downloads.
- Deploy behind HTTPS and configure backups, retention, monitoring and alerting.
- Set a strong unique `JWT_SECRET`; rotate it if exposed.
- Do not expose admin credentials or tokens in source control.
- Implement password reset and operational account recovery before public launch.
- Review upload storage limits and consider object storage for large files; current server stores file content in PostgreSQL.
- Review the app's rate limits, CSRF strategy if switching to cookies, session revocation and audit retention.
- Confirm all administrative APIs are reachable only over HTTPS.

## Verification limitation

The provider adapter is intentionally DEMO-only. The service does not query Apple or verify whether arbitrary accounts or phone numbers are activated. Results are labelled as demo/not verified. Only add live checks through an authorized provider and its documented API; never collect Apple passwords, OTPs, session cookies or private account credentials. Uploaded result files are stored for authorized workflows but their truth is not independently certified by this app.

## API overview

- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/products`
- `POST /api/tasks` (multipart TXT/CSV file or text data)
- `GET /api/tasks`
- `GET /api/tasks/:id/download/input|results`
- `GET /api/admin/users`, `POST /api/admin/users`, `PATCH /api/admin/users/:id`
- `POST /api/admin/users/:id/balance`
- `GET /api/admin/ledger`, `GET /api/admin/audit`
- `POST /api/admin/tasks/:id/results` (multipart file)
- `GET /api/admin/tasks/:id/input`

Admin routes require a signed-in user whose server-side role is `admin`.
