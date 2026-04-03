# Real OTP + Email Alerts Backend Setup

This project uses static HTML pages + a small Node/Express server to enable:

- Real OTP generation and email delivery from `bhaskargedda48@gmail.com`
- OTP verification API
- Admin broadcast simulated disaster alerts via email

## 1) Prerequisites

- Node.js installed (LTS recommended)
- Gmail App Password for `bhaskargedda48@gmail.com`

## 2) Create `.env`

1. Copy `.env.example` to `.env`
2. Set:

- `GMAIL_USER=bhaskargedda48@gmail.com`
- `GMAIL_APP_PASSWORD=...` (your 16-char app password)

## 3) Install dependencies

Run in the project folder:

- `npm install`

## 4) Start the server

- `npm start`

Server runs on:

- `http://localhost:3000`

## 5) URLs

- Landing: `http://localhost:3000/index.html`
- Registration: `http://localhost:3000/registration.html`
- Dashboard: `http://localhost:3000/dashboard.html`
- Admin: `http://localhost:3000/admin9392/` (PIN: 9392)

## Notes

- OTP is stored only in server memory (demo). Restarting the server clears pending OTPs.
- Email sending is rate-limited to avoid spam.
- SMS is not implemented yet (needs provider API key).
