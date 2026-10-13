# Data Verification Server

A standalone portal for authorized data-verification workflows.

## Initial product requirements

- Admin-issued User ID and password; no open registration by default.
- A polished, responsive dashboard with clear typography, restrained colors, and subtle 3D depth.
- iOS status and dynamic-status task screens, task history, and result downloads, with real results only when an approved provider is configured.
- TXT batch uploads with one record per line, input validation, task progress, and error reporting.
- User balance and usage overview, transparent estimated cost, and an immutable credits ledger.
- Price target: 4 USDT for 10,000 checks. Validate balance and pricing server-side; don't fake payment completion.
- Admin controls for accounts, password resets, limits, credits, pricing, and audit logs.

## Security boundaries

- Do not request or store Apple IDs, passwords, OTPs, session cookies, or other account credentials.
- Only process information the operator is authorized to verify using a legitimate provider/integration.
- Before an authorized verification provider is configured, show demo/sample results clearly marked DEMO. Do not fabricate live activation status.
- Hash passwords securely, enforce server-side roles, rate-limit login, protect uploads and downloads, and avoid logging submitted data unnecessarily.

## Current status

This repository starts as an empty project. Implement the interface and local/demo workflow first, then add authentication and server-side task processing, and only then connect a verified, authorized provider.
