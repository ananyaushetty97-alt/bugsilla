# Bugsilla

Bugsilla is a modern, self-hosted issue tracker inspired by Bugzilla's collaborative workflow. It combines familiar bug-tracking fundamentals with an API-first React interface, a Kanban board, live updates, and lightweight administration.

## Highlights

- Issue filing, filtering, saved searches, priority, assignment, and a four-state workflow.
- Product, component, version, milestone, visibility-group, and keyword classification.
- Sign-up/login, role-based administration, issue watchers, and audit history.
- Markdown comments, attachments, dependency links, and SMTP-ready notifications.
- Responsive list and Kanban views, dark mode, keyboard shortcuts, and live issue updates.

## Quick start

Prerequisites: Node.js 20 or later and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The first registered account becomes an administrator.

## Production with Docker

1. Copy `.env.example` to `.env` and set `APP_ORIGIN` to your public HTTPS URL.
2. Start the application:

```bash
docker compose up --build -d
```

The named `bugsilla-data` volume persists the SQLite database and uploads. Back it up before upgrades:

```bash
docker compose exec bugsilla tar -czf - /app/data > bugsilla-backup.tar.gz
```

## Production deployment notes

Run `npm run build` before `npm start`; in production the Express server serves the compiled React app and API from the same origin. Set these environment variables in your host dashboard:

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV=production` | Yes | Enables HTTPS-only session cookies and static app serving. |
| `APP_ORIGIN` | Yes | Exact public HTTPS URL; protects state-changing requests. |
| `PORT` | Host-dependent | API/listening port, default `3001`. |
| `SMTP_URL` | Optional | SMTP connection URL for email notification delivery. |
| `SMTP_FROM` | Optional | Sender address for notification email. |

Use a host with a persistent volume mounted at `/app/data`. The SQLite database and attachments are intentionally not committed to Git.

## Security notes

- Passwords are hashed with scrypt; sessions use opaque HTTP-only cookies.
- Production requires HTTPS and uses secure cookies.
- Auth endpoints and uploads are rate-limited in-memory.
- State-changing browser requests are restricted to `APP_ORIGIN`.
- Uploads are limited to 10 MB and an allowlist of image, text/log, patch, PDF, and ZIP MIME types.

For multi-instance or high-traffic deployments, move sessions, rate limits, files, and the database to managed services. Add malware scanning for uploaded files before accepting untrusted public traffic.

## Useful shortcuts

- `C` — file a new issue outside form fields.
- `G`, then `B` — open the board.

## License

Released under the [MIT License](LICENSE).

This project is inspired by Bugzilla's bug-tracking model; it is independent and not affiliated with Bugzilla or Mozilla.
