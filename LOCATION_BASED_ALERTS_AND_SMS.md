# Location-Based Disaster Level + SMS Notification (Simulation Document)

This project demonstrates a **simulated (fake) disaster tracking and alert system** for learning/demo purposes. The goal is to show how a real government disaster system can:

- detect/receive hazard information,
- map it to a citizen’s **location**,
- compute a **disaster severity level**,
- and send **SMS-style warning messages** and show **helpline guidance**.

## 1) Why we simulate (“fake”) disaster tracking

A real Disaster Management platform requires:

- live data feeds (IMD/INCOIS/CWC, sensors, satellite, field reports),
- verified authority approvals,
- SMS gateway/telecom integrations,
- and secure databases.

For an academic/demo project, we simulate these steps to:

- show the **full real-world workflow** without needing live integrations,
- demonstrate how alerting logic works,
- validate UI/UX, language support, and citizen journey.

## 2) Inputs we use for “location” (practical approach)

In a production system, location can come from:

- device GPS (with user permission),
- mobile tower area,
- saved address,
- Aadhaar-linked district (in some systems),
- manual selection.

### In this demo

We use **State + District selected during registration** as the user’s location context.

**Why?**

- Works even without GPS permissions
- Suitable for a government portal
- Allows district-level alert targeting (most disaster bulletins are district-based)

## 3) How we decide “disaster level” (severity)

A real system uses multiple parameters:

- hazard type (cyclone, flood, heatwave, earthquake)
- forecast time window (next 3 hours / 24 hours)
- probability/confidence
- expected impact (wind speed, rainfall mm, water level, temperature, etc.)
- vulnerability of region

### Recommended severity levels

- **Level 1 (Advisory / Watch)**
  - Awareness message
  - Basic do’s and don’ts
  - No panic, but stay alert

- **Level 2 (Warning / High Risk)**
  - Prepare to evacuate
  - Emergency kit + safe shelter guidance
  - Strong language + helpline reminder

- **Level 3 (Emergency / Severe)**
  - Immediate action required
  - Evacuation + SOS guidance
  - Priority communications

### Demo mapping approach (simple rule-based)

For simulation, you can map by:

- **Hazard type** + **district** → **predefined level**
- or **district risk score** → Level 1/2/3

Example (demo logic idea):

- Coastal districts during cyclone season → Level 2
- Districts near river basins during heavy rain → Level 2
- If the admin selects “Severe” → Level 3

## 4) SMS-style alert notification (what it represents)

In production, messages are sent through:

- SMS gateways (DLT registered templates)
- Cell broadcast
- WhatsApp/IVRS
- Push notifications

### In this demo

We show an **SMS-like notification message** in the UI (and you can later connect a real SMS API).

**Key idea**: The content of the alert is generated based on:

- user’s district/state (location)
- disaster type
- disaster level
- recommended action steps
- helpline numbers

## 5) Example SMS message templates (Level-wise)

### Level 1 (Advisory)

**NDMS Advisory (Level 1):**
`[DISTRICT], [STATE]` may face `[#DISASTER_TYPE]` in next `[#TIME]`. Stay alert. Keep phone charged. Follow official updates. Helpline: `112 / 108`.

### Level 2 (Warning)

**NDMS Warning (Level 2):**
High risk of `[#DISASTER_TYPE]` in `[#DISTRICT]`. Prepare emergency kit, secure documents, avoid low-lying areas, and be ready to move to shelter if instructed. Helpline: `112 / 108 / 1078`.

### Level 3 (Emergency)

**NDMS Emergency (Level 3):**
Severe `[#DISASTER_TYPE]` in `[#DISTRICT]`. Move to safe shelter immediately. Avoid travel. If trapped, use SOS or call `112/108`. Keep family informed.

## 6) Why we show disaster information + helplines

### A) Disaster information

Showing disaster details (type, level, advice) is necessary because:

- citizens need **clear, actionable instructions** (not only “danger”) 
- reduces panic and confusion
- improves compliance (evacuation, shelter, do’s/don’ts)
- helps people plan (elderly, children, medicines, documents)

### B) Helpline numbers

Helplines are included because:

- disasters create urgent, unpredictable situations
- citizens may need:
  - ambulance (medical emergency)
  - police support
  - fire services
  - rescue teams (NDRF/SDRF)
- some people cannot use internet during a disaster, but **SMS + voice call** still works

**Typical helplines used in India (examples):**

- `112` National Emergency Response Support System
- `108` Ambulance
- `101` Fire
- `100` Police
- `1078` Disaster Management Control Room (varies by state)

(You can replace these with your state’s official numbers.)

## 7) Real-time scenario example (practical story)

1. Citizen registers and selects:
   - State: Andhra Pradesh
   - District: Visakhapatnam
2. System identifies district as coastal → cyclone risk.
3. Admin marks a simulated cyclone warning as Level 2.
4. The system generates an SMS-style message:
   - “High risk of Cyclone in Visakhapatnam… prepare kit… helpline…”
5. Citizen sees the alert on dashboard and uses SOS if needed.

## 8)  Notes for your report / viva

- This is a **simulation model** meant to show how a real NDMA/SDMA-style platform works.
- Real deployments would include:
  - authenticated admin alert publishing
  - live data feeds
  - GIS mapping
  - SMS gateway integration
  - audit logs and verification workflows
- The key learning outcome is **location-based targeting + severity-based messaging + citizen guidance**.
