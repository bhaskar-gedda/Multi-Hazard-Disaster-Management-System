# Real-Time Working Scenario (Practical Flow)

This project is a **Government-style Disaster Management System (NDMS)** demo website with **multi-language support** (English, Hindi, Telugu).

It is built as a **static front-end** (HTML + TailwindCSS + JavaScript) and demonstrates how a citizen-facing disaster portal would work in a real-world scenario.

## 1) What this system demonstrates

- **Citizen journey**
  - Landing page awareness + quick actions
  - Registration with OTP verification
  - Dashboard with user context and emergency actions
- **Language switching that persists across pages**
  - English / हिन्दी / తెలుగు
- **Session simulation using browser storage**
  - Uses `localStorage` to simulate logged-in/registered state

## 2) Pages and what they represent in real life

- `index.html`
  - Represents the **public portal** used by citizens during normal time and emergencies.
  - Shows emergency actions, helplines, preparedness information, and a clear call to register.

- `registration.html`
  - Represents **citizen onboarding** (like creating an account / linking a mobile number).
  - Includes a **3-step flow**:
    1. Details form
    2. OTP verification
    3. Success + redirect

- `dashboard.html`
  - Represents a **personalized citizen dashboard** after successful registration.
  - Shows important emergency actions (SOS), services, and user greeting.

## 3) Real-world scenario: end-to-end flow

### Step A: Citizen opens the portal (normal time)

1. Citizen visits the portal:
   - `http://localhost:3000/index.html`
2. Citizen switches language if needed:
   - Selects **English / हिन्दी / తెలుగు**
3. The portal displays localized text immediately.

**Real-life equivalent**: A government portal that auto-serves content based on user preference, region, or device language.

### Step B: Citizen registers during preparedness or after an alert

1. Citizen clicks **Register Now** on landing page.
2. Citizen fills in details on `registration.html`:
   - Name
   - Mobile number
   - State and District
   - Consent checkbox
3. Citizen clicks **Send OTP**.
4. Citizen enters OTP.
   - Demo OTP: `123456`
5. On successful OTP verification:
   - The system marks the user as registered and redirects to `dashboard.html`.

**Real-life equivalent**:
- OTP would be generated server-side and sent via SMS gateway.
- Registration would create a record in a database and map citizen to a district/state for geo-targeted alerts.

### Step C: Citizen uses dashboard during an emergency

1. Citizen lands on dashboard and sees their welcome line.
2. Citizen clicks **SOS** if they need immediate help.
3. Citizen can also access emergency services quickly.

**Real-life equivalent**:
- SOS would raise an incident ticket.
- The system could transmit:
  - GPS location
  - Phone number
  - Type of help required
  - Timestamp
- Authorities could route to:
  - Police
  - Fire
  - Ambulance
  - NDRF/SDRF

## 4) How language works (real-time across pages)

### Where translations live

- `translations.js`
  - Contains the translation dictionary:
    - `en` (English)
    - `hi` (Hindi)
    - `te` (Telugu)

### How language is applied

- `i18n.js`
  - Reads/writes the selected language in `localStorage` under key `lang`
  - Applies translations to elements using:
    - `data-i18n="section.key"` for text content
    - `data-i18n-placeholder="section.key"` for placeholders

### Why it persists across pages

- Because `lang` is stored in `localStorage`, when a new page loads:
  - `i18n.js` reads the stored value and applies the same language again.

## 5) How registration and “session” works (practical simulation)

This project simulates authentication/registration using `localStorage`.

### Stored values

- `userName`
- `userPhone`
- `isRegistered`

### Dashboard guard

- `dashboard.html` checks `isRegistered`.
- If missing, it redirects back to `registration.html`.

**Real-life equivalent**:
- This would be replaced with real authentication tokens (JWT/session cookies) and server-side authorization.

## 6) Real-time updates: what’s real vs what’s simulated

### Simulated in this demo

- OTP verification (fixed demo OTP)
- “Live alerts” sections are UI-based demos
- Registration state stored in browser

### What would be real in production

- **Alert feeds** from IMD/INCOIS/CWC/NDMA systems
- **Geo-targeted notifications** by district/state
- **SMS/IVRS/WhatsApp push** integrations
- **Admin dashboard** for authorities to create and verify alerts
- **Incident management workflow** for SOS/tickets

## 7) How to run and test like a real user

1. Start local server (example):
   - `python -m http.server 3000`
2. Open landing page:
   - `http://localhost:3000/index.html`
3. Switch language and confirm persistence by navigating to:
   - `registration.html`
   - `dashboard.html`
4. Complete registration using OTP:
   - `123456`
5. Verify dashboard guard:
   - Clear storage and refresh dashboard to confirm redirect:
     - Browser DevTools -> Application -> Local Storage -> clear

## 8) Common practical checks

- Language switch changes content on every page
- Registration form validations block invalid inputs
- OTP resend button enables only after timer
- Successful OTP redirects to dashboard
- Logout clears registration and returns user to landing
