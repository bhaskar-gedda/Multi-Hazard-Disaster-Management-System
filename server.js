const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
require('dotenv').config();

// Blockchain module
const blockchainAudit = require('./blockchain/auditTrail');

const app = express();

process.on('unhandledRejection', (reason) => {
  console.error('[Process] unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] uncaughtException:', err);
});

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve(__dirname);

const DATA_DIR = path.resolve(__dirname, 'data');
const USERS_DB_FILE = path.join(DATA_DIR, 'users.json');
const ALERTS_DB_FILE = path.join(DATA_DIR, 'alerts.json');

// Auto-alert settings (server-driven alerts without admin intervention)
const AUTO_ALERT_ENABLED_DEFAULT = true;
const AUTO_ALERT_INTERVAL_MS = Number(process.env.AUTO_ALERT_INTERVAL_MS || 60 * 1000);
const AUTO_ALERT_COOLDOWN_MS = Number(process.env.AUTO_ALERT_COOLDOWN_MS || 10 * 60 * 1000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Basic rate limiting (protects OTP + email sending)
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const mailLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function httpsGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    try {
      const req = https.get(
        url,
        { headers: { 'User-Agent': 'NDMS/1.0 (Disaster Management System)' } },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const status = Number(res.statusCode || 0);
              if (status < 200 || status >= 300) {
                return reject(new Error(`HTTP ${status}: ${String(data).slice(0, 250)}`));
              }
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        }
      );

      req.setTimeout(timeoutMs, () => {
        try { req.destroy(new Error('Request timeout')); } catch { /* ignore */ }
      });
      req.on('error', (err) => reject(err));
    } catch (e) {
      reject(e);
    }
  });
}

const realtimeCache = new Map();
async function cachedJson(key, ttlMs, loader) {
  const now = Date.now();
  const hit = realtimeCache.get(key);
  if (hit && hit.expiresAt > now && 'value' in hit) return hit.value;
  if (hit && hit.inflight) return hit.inflight;

  const inflight = Promise.resolve()
    .then(loader)
    .then((value) => {
      realtimeCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .catch((e) => {
      realtimeCache.delete(key);
      throw e;
    });

  realtimeCache.set(key, { inflight, expiresAt: now + ttlMs });
  return inflight;
}

function weatherApiKey() {
  const k = String(process.env.WEATHERAPI_KEY || '').trim();
  return k || '';
}

async function getWeatherNow(lat, lng) {
  const key = weatherApiKey();
  if (key) {
    try {
      const url =
        'https://api.weatherapi.com/v1/current.json' +
        `?key=${encodeURIComponent(key)}` +
        `&q=${encodeURIComponent(`${lat},${lng}`)}` +
        '&aqi=no';
      const data = await cachedJson(`wx:weatherapi:${lat.toFixed(3)}:${lng.toFixed(3)}`, 2 * 60 * 1000, () => httpsGetJson(url));
      const cur = data?.current || {};
      const loc = data?.location || {};
      const gustKph = Number(cur?.gust_kph);
      const windKph = Number(cur?.wind_kph);
      return {
        ok: true,
        source: 'weatherapi',
        time: String(cur?.last_updated || ''),
        temperatureC: Number.isFinite(Number(cur?.temp_c)) ? Number(cur?.temp_c) : null,
        pressureHpa: Number.isFinite(Number(cur?.pressure_mb)) ? Number(cur?.pressure_mb) : null,
        precipitationMm: Number.isFinite(Number(cur?.precip_mm)) ? Number(cur?.precip_mm) : null,
        windGust: Number.isFinite(gustKph) ? gustKph : Number.isFinite(windKph) ? windKph : null,
        locationName: String(loc?.name || ''),
        region: String(loc?.region || ''),
        country: String(loc?.country || ''),
      };
    } catch {
      // fall through to open-meteo
    }
  }

  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lng)}` +
    '&current=temperature_2m,precipitation,rain,pressure_msl,wind_speed_10m,wind_gusts_10m' +
    '&timezone=auto';

  const data = await cachedJson(`wx:openmeteo:${lat.toFixed(3)}:${lng.toFixed(3)}`, 2 * 60 * 1000, () => httpsGetJson(url));
  const cur = data?.current || {};
  console.log('[Weather API] Open-Meteo raw data:', JSON.stringify(data).slice(0, 800));
  console.log('[Weather API] Current temp:', cur?.temperature_2m, 'Type:', typeof cur?.temperature_2m);
  return {
    ok: true,
    source: 'open-meteo',
    time: String(cur?.time || ''),
    temperatureC: Number.isFinite(Number(cur?.temperature_2m)) ? Number(cur.temperature_2m) : null,
    pressureHpa: Number.isFinite(Number(cur?.pressure_msl)) ? Number(cur.pressure_msl) : null,
    precipitationMm: Number.isFinite(Number(cur?.precipitation)) ? Number(cur.precipitation) : null,
    windGust: Number.isFinite(Number(cur?.wind_gusts_10m)) ? Number(cur.wind_gusts_10m) : null,
  };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clamp010(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

function floodFeaturesFromWeather(wx, opts = {}) {
  const rainfallMm = Number(wx?.precipitationMm);
  const riverLevelM = Number(opts?.river_level_m);

  const now = new Date();
  const month = now.getMonth() + 1;
  const dayofweek = now.getDay();

  return {
    rainfall_mm: Number.isFinite(rainfallMm) ? rainfallMm : 0,
    river_level_m: Number.isFinite(riverLevelM) ? riverLevelM : 0,
    month,
    dayofweek,
    state: String(opts?.state || 'Unknown'),
    district: String(opts?.district || 'Unknown'),
  };
}

function riskLabelToSeverity(riskLabel) {
  const r = String(riskLabel || '').trim().toLowerCase();
  if (r === 'high') return 'high';
  if (r === 'medium') return 'medium';
  return 'low';
}

async function getRiverDischargeOpenMeteo(lat, lng) {
  try {
    const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&daily=river_discharge&forecast_days=1`;
    console.log(`[River API] Calling Open-Meteo: ${url}`);
    const data = await cachedJson(`river:openmeteo:${lat.toFixed(3)}:${lng.toFixed(3)}`, 30 * 60 * 1000, () => httpsGetJson(url));
    console.log(`[River API] Open-Meteo response:`, JSON.stringify(data).slice(0, 500));
    
    const daily = data?.daily;
    if (!daily || !Array.isArray(daily.river_discharge)) {
      console.log(`[River API] No river discharge data in response`);
      return { ok: false, error: 'No river discharge data available' };
    }
    
    // Get today's discharge (m³/s)
    const todayDischarge = daily.river_discharge[0];
    console.log(`[River API] Today discharge: ${todayDischarge}`);
    if (!Number.isFinite(todayDischarge)) {
      return { ok: false, error: 'Invalid discharge value' };
    }
    
    // Convert discharge (m³/s) to estimated river level (m)
    const estimatedLevel = estimateLevelFromDischarge(todayDischarge);
    console.log(`[River API] Estimated level: ${estimatedLevel}m from ${todayDischarge} m³/s`);
    
    return {
      ok: true,
      source: 'open-meteo',
      dischargeM3s: todayDischarge,
      estimatedLevelM: estimatedLevel,
      unit: 'm³/s',
      time: daily.time?.[0] || new Date().toISOString(),
    };
  } catch (e) {
    console.log(`[River API] Error: ${e?.message || e}`);
    return { ok: false, error: String(e?.message || e) };
  }
}

// Rough estimation: convert river discharge (m³/s) to water level (m)
// This uses a simplified hydraulic formula assuming typical river geometry
function estimateLevelFromDischarge(dischargeM3s) {
  const Q = Number(dischargeM3s);
  if (!Number.isFinite(Q) || Q <= 0) return 0;
  
  // Simplified: level = base + factor * sqrt(Q)
  // Typical small-to-medium river: base 0.5m, increases with flow
  const baseLevel = 0.5;
  const factor = 0.15; // Adjust based on typical Indian rivers
  const estimated = baseLevel + factor * Math.sqrt(Q);
  
  // Cap at realistic max (15m for major flood stage)
  return Math.min(15, Math.max(0, estimated));
}

// CWC Flood Forecast scraper - attempts to get data from CWC website
async function getCWCFloodData(state, district) {
  try {
    // CWC doesn't have a simple public API, but we can try their flood forecast portal
    // This is a best-effort attempt - may need updates if CWC changes their website
    const url = 'https://ffs.india-water.gov.in/home/index.php';
    
    // For now, return estimated based on historical data
    // In production, this could scrape the HTML or use CWC's internal API if available
    return { 
      ok: false, 
      error: 'CWC API requires manual integration or scraping - using Open-Meteo fallback',
      fallback: true 
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Combined river data fetcher: tries Open-Meteo first, then CWC, then estimation
async function getRiverData(lat, lng, state, district) {
  // Try Open-Meteo first (global coverage, free, no API key)
  const openMeteo = await getRiverDischargeOpenMeteo(lat, lng);
  if (openMeteo.ok) {
    return {
      ok: true,
      source: 'open-meteo',
      dischargeM3s: openMeteo.dischargeM3s,
      riverLevelM: openMeteo.estimatedLevelM,
      method: 'discharge-based-estimation',
      time: openMeteo.time,
    };
  }
  
  // Fallback: try CWC (if implemented)
  const cwc = await getCWCFloodData(state, district);
  if (cwc.ok) {
    return {
      ok: true,
      source: 'cwc',
      riverLevelM: cwc.riverLevelM,
      method: 'direct-measurement',
      time: cwc.time,
    };
  }
  
  // Final fallback: rainfall-based estimation
  return { ok: false, error: 'No river data source available' };
}

// Rainfall-based estimation fallback when no river data available
function estimateRiverLevelM({ precipitationMm }) {
  const p = Number(precipitationMm);
  if (!Number.isFinite(p) || p <= 0) return 0;
  // Simple heuristic: heavier rain => higher estimated river level
  const scale = Number(process.env.AUTO_RIVERLEVEL_SCALE || 0.25);
  const offset = Number(process.env.AUTO_RIVERLEVEL_OFFSET || 0);
  const est = p * scale + offset;
  return Math.max(0, Math.min(15, est));
}

const autoAlertState = {
  enabled: String(process.env.AUTO_ALERTS_ENABLED || '').trim() ? ['1', 'true', 'yes', 'on'].includes(String(process.env.AUTO_ALERTS_ENABLED).trim().toLowerCase()) : AUTO_ALERT_ENABLED_DEFAULT,
  lastSent: new Map(),
  running: false,
};

function autoAlertKey(user, type, severity) {
  const id = String(user?.id || user?.phone || user?.email || '').trim() || 'unknown';
  return `${id}:${String(type || '').trim().toLowerCase()}:${String(severity || '').trim().toLowerCase()}`;
}

function canSendAutoAlert(user, type, severity) {
  const key = autoAlertKey(user, type, severity);
  const last = Number(autoAlertState.lastSent.get(key) || 0);
  return (Date.now() - last) > AUTO_ALERT_COOLDOWN_MS;
}

function markAutoAlertSent(user, type, severity) {
  const key = autoAlertKey(user, type, severity);
  autoAlertState.lastSent.set(key, Date.now());
}

async function createAndSendAutoAlert({ user, type, severity, lat, lng, locationLabel, message, reasons }) {
  const emojiMap = { flood: '🌊', earthquake: '🌍', weather: '🌦️', multi: '🚨' };
  const riskMap = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' };
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 60 * 60 * 1000).toISOString();
  const id = `AA-${now}-${Math.floor(Math.random() * 1000)}`;

  const alertObj = {
    id,
    type,
    emoji: emojiMap[type] || '🚨',
    severity,
    riskLevel: riskMap[severity] || 'MEDIUM',
    location: locationLabel || (Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : '—'),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    radiusKm: 0,
    durationMin: 60,
    message: String(message || '').trim() || 'Automated risk alert generated by NDMS.',
    createdAt,
    expiresAt,
    simulated: false,
    auto: true,
    reasons: Array.isArray(reasons) ? reasons : [],
    user: { id: String(user?.id || ''), phone: String(user?.phone || ''), email: String(user?.email || ''), name: String(user?.name || '') }
  };

  const to = String(user?.email || '').trim().toLowerCase();
  if (to && to.includes('@')) {
    const subject = `${alertObj.emoji} NDMS AUTO ALERT (${alertObj.riskLevel}) - ${alertObj.location}`;
    const mapLink = Number.isFinite(lat) && Number.isFinite(lng) ? `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}` : '';
    const baseText =
      `NDMS - AUTOMATED DISASTER ALERT\n\n` +
      `Type: ${String(type || '').toUpperCase()}\n` +
      `Risk Level: ${alertObj.riskLevel}\n` +
      `Location: ${alertObj.location}\n` +
      `Active Until: ${expiresAt}\n\n` +
      (reasons && reasons.length ? `Reasons:\n- ${reasons.join('\n- ')}\n\n` : '') +
      (mapLink ? `Map: ${mapLink}\n\n` : '') +
      `Message:\n${alertObj.message}\n\n` +
      `User: ${user?.name || 'Citizen'}\n` +
      `\n— NDMS (Auto Monitoring)`;
    await sendAlertEmail({ to, subject, text: baseText, severity });
  }

  const alerts = readAlertsDb();
  alerts.unshift(alertObj);
  writeAlertsDb(alerts);
  sseSend('alerts', activeAlertsNow());

  return alertObj;
}

async function runAutoAlertCycle() {
  if (!autoAlertState.enabled) return;
  if (autoAlertState.running) return;
  autoAlertState.running = true;
  try {
    const users = readUsersDb().filter(u => String(u?.status || 'active') === 'active');
    for (const u of users) {
      const lat = Number(u?.lat);
      const lng = Number(u?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const state = String(u?.state || '').trim() || 'Unknown';
      const district = String(u?.district || '').trim() || 'Unknown';

      // Weather + EQ are cached inside these endpoints anyway.
      const [wx, eq] = await Promise.all([
        cachedJson(`auto:wx:${lat.toFixed(3)}:${lng.toFixed(3)}`, 2 * 60 * 1000, () => getWeatherNow(lat, lng)),
        cachedJson(`auto:eq:${lat.toFixed(3)}:${lng.toFixed(3)}:300:1440`, 30 * 1000, async () => {
          const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const url =
            'https://earthquake.usgs.gov/fdsnws/event/1/query' +
            `?format=geojson&latitude=${encodeURIComponent(lat)}` +
            `&longitude=${encodeURIComponent(lng)}` +
            `&maxradiuskm=${encodeURIComponent(300)}` +
            `&starttime=${encodeURIComponent(start)}` +
            '&orderby=time&limit=50';
          return httpsGetJson(url);
        })
      ]);

      const features = Array.isArray(eq?.features) ? eq.features : [];
      const mags = features.map(f => Number(f?.properties?.mag)).filter(n => Number.isFinite(n));
      const maxMag = mags.length ? Math.max(...mags) : 0;

      // 1) General realtime ML risk
      let generalRisk = null;
      try {
        const script = path.join(__dirname, 'ml', 'predict.py');
        const pred = await runPythonJson(script, {
          features: {
            precipitation_mm: Number(wx?.precipitationMm ?? 0),
            wind_gust: Number(wx?.windGust ?? 0),
            pressure_hpa: Number(wx?.pressureHpa ?? 0),
            temp_c: Number(wx?.temperatureC ?? 0),
            max_mag: Number.isFinite(maxMag) ? maxMag : 0,
          }
        }, 12000);
        generalRisk = String(pred?.risk_label || '').trim().toLowerCase();
      } catch {
        generalRisk = null;
      }

      // 2) Flood ML risk (with real river data from Open-Meteo/CWC)
      let floodRisk = null;
      let floodSeverity = null;
      let riverSource = 'none';
      try {
        const riverData = await getRiverData(lat, lng, state, district);
        let river_level_m;
        if (riverData.ok) {
          river_level_m = riverData.riverLevelM;
          riverSource = riverData.source;
        } else {
          river_level_m = estimateRiverLevelM({ precipitationMm: wx?.precipitationMm });
          riverSource = 'rainfall-estimate';
        }
        const floodFeats = floodFeaturesFromWeather(wx, { state, district, river_level_m });
        const script = path.join(__dirname, 'ml', 'flood_predict.py');
        const pred = await runPythonJson(script, { features: floodFeats }, 12000);
        floodRisk = String(pred?.risk_label || '').trim().toLowerCase();
        floodSeverity = String(pred?.flood_severity || '').trim();
      } catch {
        floodRisk = null;
      }

      const reasons = [];
      if (Number.isFinite(Number(wx?.precipitationMm))) reasons.push(`rain=${Number(wx.precipitationMm)}mm`);
      if (Number.isFinite(Number(wx?.windGust))) reasons.push(`gust=${Number(wx.windGust)}`);
      if (Number.isFinite(maxMag) && maxMag > 0) reasons.push(`maxMag=${maxMag.toFixed(1)}`);
      if (floodSeverity) reasons.push(`floodSeverity=${floodSeverity}`);

      const candidates = [];
      if (generalRisk) candidates.push({ type: 'multi', riskLabel: generalRisk });
      if (floodRisk) candidates.push({ type: 'flood', riskLabel: floodRisk });

      for (const c of candidates) {
        const severity = riskLabelToSeverity(c.riskLabel);
        if (severity !== 'high') continue;
        if (!canSendAutoAlert(u, c.type, severity)) continue;
        await createAndSendAutoAlert({
          user: u,
          type: c.type,
          severity,
          lat,
          lng,
          locationLabel: `${district}${state ? ', ' + state : ''}`.trim(),
          message: c.type === 'flood'
            ? 'High flood risk predicted near you. Move to higher ground and avoid low-lying areas.'
            : 'High risk predicted near you. Stay alert and follow official guidance.',
          reasons,
        });
        markAutoAlertSent(u, c.type, severity);
      }
    }
  } finally {
    autoAlertState.running = false;
  }
}

function pythonBin() {
  const v = String(process.env.PYTHON_BIN || '').trim();
  return v || 'python';
}

function runPythonJson(scriptPath, inputObj, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const py = pythonBin();
    const child = spawn(py, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('Python process timed out'));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const out = String(stdout || '').trim();
      try {
        const parsed = out ? JSON.parse(out) : {};
        if (parsed && parsed.ok === false) {
          return reject(new Error(parsed.error || 'Python returned ok=false'));
        }
        if (code !== 0 && parsed && parsed.ok !== true) {
          return reject(new Error((stderr || out || `Python exit ${code}`).slice(0, 300)));
        }
        resolve(parsed);
      } catch {
        reject(new Error((stderr || out || `Python exit ${code}`).slice(0, 300)));
      }
    });

    try {
      child.stdin.write(JSON.stringify(inputObj || {}));
      child.stdin.end();
    } catch {
      // ignore
    }
  });
}

app.get('/api/admin/alerts', (_req, res) => {
  res.json({ ok: true, alerts: activeAlertsNow() });
});

app.post('/api/admin/alerts', mailLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const type = String(body?.type || '').trim().toLowerCase();
    const severity = String(body?.severity || 'medium').trim().toLowerCase();
    const durationMin = Number(body?.durationMin || body?.duration || 60);
    const radiusKm = Number(body?.radiusKm || body?.radius || 10);
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    const locationLabel = String(body?.location || '').trim();
    const force = Boolean(body?.force); // allow override if validation fails

    const allowedTypes = new Set(['flood', 'earthquake']);
    if (!allowedTypes.has(type)) return res.status(400).json({ ok: false, error: 'Only flood and earthquake alerts are supported. Other models not trained yet.' });
    if (!['low', 'medium', 'high'].includes(severity)) return res.status(400).json({ ok: false, error: 'severity must be low|medium|high' });
    if (!Number.isFinite(durationMin) || durationMin < 1 || durationMin > 1440) return res.status(400).json({ ok: false, error: 'durationMin must be 1..1440' });
    if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 200) return res.status(400).json({ ok: false, error: 'radiusKm must be 1..200' });
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ ok: false, error: 'lat and lng are required' });

    // Real-time validation: verify alert matches actual conditions
    const validation = await validateAlertConditions({ type, lat, lng, radiusKm });
    if (!validation.ok && !force) {
      return res.status(400).json({
        ok: false,
        error: `Alert validation failed: ${validation.reason}. Use force=true to override (emergency only).`,
        validation,
        hint: 'If this is a real emergency not yet detected by APIs, resend with force=true'
      });
    }

    const emojiMap = { flood: '🌊', earthquake: '🌍' };
    const riskMap = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' };
    const causeMap = {
      flood: 'Heavy rainfall, dam releases, river overflow, or poor drainage can cause floods.',
      earthquake: 'Tectonic plate movement, fault line activity, or seismic events can cause earthquakes.'
    };
    const precautionMap = {
      flood: {
        low: ['Stay updated with local advisories.', 'Keep power banks/flashlights ready.'],
        medium: ['Avoid low-lying areas.', 'Move valuables/documents to higher levels.', 'Keep drinking water and medicines ready.'],
        high: ['Evacuate to higher ground immediately.', 'Switch off electricity/gas.', 'Do not attempt to cross flooded roads.']
      },
      earthquake: {
        low: ['Stay calm and be prepared.', 'Secure loose items that could fall.'],
        medium: ['Drop, cover, and hold on.', 'Stay away from windows and heavy furniture.', 'Prepare emergency kit.'],
        high: ['Evacuate building immediately if safe to do so.', 'Avoid elevators and stairs during shaking.', 'Move to open area away from buildings.']
      }
    };

    const defaultMsg = {
      flood: `Flood alert in ${locationLabel || 'your area'}. Take precautions immediately.`,
      earthquake: `Earthquake alert in ${locationLabel || 'your area'}. Take immediate safety precautions.`
    };

    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + durationMin * 60 * 1000).toISOString();
    const id = `A-${now}`;

    const alertObj = {
      id,
      type,
      emoji: emojiMap[type] || '🚨',
      severity,
      riskLevel: riskMap[severity] || 'MEDIUM',
      location: locationLabel || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      lat,
      lng,
      radiusKm,
      durationMin,
      message: String(body?.message || '').trim() || defaultMsg[type],
      createdAt,
      expiresAt,
      simulated: true
    };

    const users = readUsersDb().filter(u => String(u?.status || 'active') === 'active');
    const targeted = users
      .map(u => {
        const ulat = Number(u?.lat);
        const ulng = Number(u?.lng);
        // Only use GPS distance matching when radius is specified
        // Users without GPS coordinates are excluded from radius-based alerts
        if (Number.isFinite(ulat) && Number.isFinite(ulng)) {
          const d = kmBetween(lat, lng, ulat, ulng);
          if (d > radiusKm) return null;
          return { user: u, distanceKm: d, reason: 'gps' };
        }
        // No fallback to state/district for radius-based alerts
        // This prevents users in other cities within same state from getting alerts
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => {
        const ad = Number.isFinite(a.distanceKm) ? a.distanceKm : 1e9;
        const bd = Number.isFinite(b.distanceKm) ? b.distanceKm : 1e9;
        return ad - bd;
      });

    const subject = `${alertObj.emoji} NDMS ${type.toUpperCase()} ALERT (${alertObj.riskLevel}) - ${alertObj.location}`;

    const mapLink = `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`;
    const safeHospital = `https://www.google.com/maps/search/${encodeURIComponent('hospitals near me')}`;
    const safeShelter = `https://www.google.com/maps/search/${encodeURIComponent('shelter near me')}`;
    const safePolice = `https://www.google.com/maps/search/${encodeURIComponent('police station near me')}`;
    const safeFire = `https://www.google.com/maps/search/${encodeURIComponent('fire station near me')}`;

    const precautions = precautionMap[type]?.[severity] || [];
    const precautionsText = precautions.map((p, i) => `${i + 1}. ${p}`).join('\n');

    const baseText =
      `NDMS - SIMULATED DISASTER ALERT\n\n` +
      `Type: ${type.toUpperCase()}\n` +
      `Risk Level: ${alertObj.riskLevel}\n` +
      `Location: ${alertObj.location}\n` +
      `Radius: ${radiusKm} km\n` +
      `Active Until: ${expiresAt}\n\n` +
      `Reason/Cause:\n${causeMap[type] || '—'}\n\n` +
      `Precautions:\n${precautionsText || '—'}\n\n` +
      `Map Link: ${mapLink}\n` +
      `Safe Places (Google Maps):\n` +
      `- Hospitals: ${safeHospital}\n` +
      `- Shelters: ${safeShelter}\n` +
      `- Police: ${safePolice}\n` +
      `- Fire: ${safeFire}\n\n` +
      `Message:\n${alertObj.message}\n\n` +
      `— NDMS (Simulation)`;

    let sent = 0;
    for (const t of targeted) {
      const to = String(t.user?.email || '').trim().toLowerCase();
      if (!to || !to.includes('@')) continue;
      const perUser =
        `${baseText}\n\n` +
        `User: ${t.user?.name || 'Citizen'}\n` +
        (Number.isFinite(t.distanceKm)
          ? `Distance from epicenter: ${t.distanceKm.toFixed(1)} km\n`
          : 'Targeted by: State/District match (GPS unavailable)\n');
      await sendAlertEmail({ to, subject, text: perUser, severity });
      sent += 1;
    }

    const alerts = readAlertsDb();
    alerts.unshift(alertObj);
    writeAlertsDb(alerts);
    sseSend('alerts', activeAlertsNow());

    const gpsCount = targeted.filter(t => t.reason === 'gps').length;
    const sdCount = targeted.filter(t => t.reason === 'state_district').length;
    return res.json({ ok: true, alert: alertObj, targeted: targeted.length, emailed: sent, targetedByGps: gpsCount, targetedByStateDistrict: sdCount });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to create alert' });
  }
});

app.get('/api/alerts/active', (_req, res) => {
  res.json({ ok: true, alerts: activeAlertsNow() });
});

// Get alerts for a specific state (combines flood-prone zones + active alerts)
app.get('/api/alerts/state', async (req, res) => {
  try {
    const stateName = String(req.query.state || '').trim();
    if (!stateName) {
      return res.status(400).json({ ok: false, error: 'state parameter required' });
    }
    
    const alerts = [];
    
    // 1. Get flood-prone zones for this state from allIndiaFloodZones
    const stateZones = allIndiaFloodZones.filter(z => 
      z.state.toLowerCase() === stateName.toLowerCase()
    );
    
    // 2. Check weather for each zone and generate alerts
    for (const zone of stateZones.slice(0, 20)) { // Limit to 20 zones per state
      try {
        const wx = await getWeatherNow(zone.lat, zone.lng);
        const rainfall = Number(wx?.precipitationMm) || 0;
        
        let severity = zone.riskFactor;
        let message = `${zone.name}: `;
        let event = 'Flood Watch';
        
        if (rainfall >= 50) {
          severity = 'high';
          event = 'Flood Warning';
          message += `Heavy rainfall ${rainfall}mm. Severe flood risk.`;
        } else if (rainfall >= 20) {
          severity = severity === 'high' ? 'high' : 'moderate';
          event = 'Flood Alert';
          message += `Moderate rainfall ${rainfall}mm. Elevated flood risk.`;
        } else if (rainfall >= 5) {
          event = 'Flood Watch';
          message += `Light rainfall ${rainfall}mm. Monitor situation.`;
        } else {
          // Skip low-risk areas with no rain to reduce clutter
          if (zone.riskFactor === 'low') continue;
          message += `No rainfall. Historical flood-prone zone.`;
        }
        
        alerts.push({
          id: `flood-${zone.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
          type: 'flood',
          lat: zone.lat,
          lng: zone.lng,
          severity: severity,
          location: `${zone.name}, ${zone.state}`,
          event: event,
          message: message,
          rainfallMm: rainfall,
          issuedBy: ' Govt. of ' + zone.state,
          createdAt: new Date().toISOString()
        });
      } catch (e) {
        // If weather fetch fails, include zone with base risk
        if (zone.riskFactor !== 'low') {
          alerts.push({
            id: `flood-${zone.name.toLowerCase().replace(/\s+/g, '-')}-base`,
            type: 'flood',
            lat: zone.lat,
            lng: zone.lng,
            severity: zone.riskFactor,
            location: `${zone.name}, ${zone.state}`,
            event: 'Flood Alert',
            message: `${zone.name}: Historical flood-prone area.`,
            rainfallMm: null,
            issuedBy: 'Govt. of ' + zone.state,
            createdAt: new Date().toISOString()
          });
        }
      }
    }
    
    // 3. Also include active alerts from database that match this state
    const activeAlerts = activeAlertsNow();
    const stateActiveAlerts = activeAlerts.filter(a => {
      const alertState = String(a.location || '').toLowerCase();
      return alertState.includes(stateName.toLowerCase());
    });
    
    // Merge stateActiveAlerts into alerts array
    stateActiveAlerts.forEach(a => {
      alerts.push({
        ...a,
        event: a.event || 'Disaster Alert',
        issuedBy: a.issuedBy || 'NDMA'
      });
    });
    
    res.json({ ok: true, state: stateName, count: alerts.length, alerts });
  } catch (e) {
    console.error('[StateAlerts] Error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// All-India flood alerts endpoint with real-time weather data
const allIndiaFloodZones = [
  // River Basins and flood-prone areas
  { name: 'Kosi River Basin', state: 'Bihar', lat: 26.0, lng: 87.5, riskFactor: 'high' },
  { name: 'Ganga Basin - Bihar', state: 'Bihar', lat: 25.5, lng: 84.0, riskFactor: 'high' },
  { name: 'Ganga Basin - UP', state: 'Uttar Pradesh', lat: 27.0, lng: 83.0, riskFactor: 'moderate' },
  { name: 'Yamuna Basin - Delhi', state: 'Delhi', lat: 28.6, lng: 77.2, riskFactor: 'moderate' },
  { name: 'Yamuna Basin - Agra', state: 'Uttar Pradesh', lat: 27.2, lng: 78.0, riskFactor: 'moderate' },
  { name: 'Brahmaputra Basin', state: 'Assam', lat: 26.2, lng: 91.7, riskFactor: 'high' },
  { name: 'Barak Valley', state: 'Assam', lat: 24.8, lng: 92.8, riskFactor: 'high' },
  { name: 'Godavari Delta', state: 'Andhra Pradesh', lat: 16.5, lng: 81.0, riskFactor: 'moderate' },
  { name: 'Godavari Basin - Nashik', state: 'Maharashtra', lat: 20.0, lng: 73.8, riskFactor: 'moderate' },
  { name: 'Krishna Delta', state: 'Andhra Pradesh', lat: 15.8, lng: 80.6, riskFactor: 'moderate' },
  { name: 'Mahanadi Basin', state: 'Odisha', lat: 20.3, lng: 85.8, riskFactor: 'high' },
  { name: 'Narmada Basin', state: 'Madhya Pradesh', lat: 22.6, lng: 76.0, riskFactor: 'low' },
  { name: 'Tapti Basin', state: 'Maharashtra', lat: 21.2, lng: 74.8, riskFactor: 'moderate' },
  { name: 'Cauvery Delta', state: 'Tamil Nadu', lat: 11.0, lng: 79.8, riskFactor: 'low' },
  { name: 'Sundarbans', state: 'West Bengal', lat: 22.5, lng: 88.0, riskFactor: 'high' },
  { name: 'Hooghly Basin', state: 'West Bengal', lat: 22.9, lng: 88.4, riskFactor: 'moderate' },
  { name: 'Kerala Backwaters', state: 'Kerala', lat: 10.0, lng: 76.5, riskFactor: 'moderate' },
  { name: 'Vembanad Lake', state: 'Kerala', lat: 9.6, lng: 76.5, riskFactor: 'high' },
  { name: 'Mumbai Coastal', state: 'Maharashtra', lat: 19.0, lng: 72.8, riskFactor: 'high' },
  { name: 'Gujarat Coast', state: 'Gujarat', lat: 21.5, lng: 70.0, riskFactor: 'moderate' },
  { name: 'Odisha Coast', state: 'Odisha', lat: 20.3, lng: 86.7, riskFactor: 'high' },
  { name: 'Andhra Coast', state: 'Andhra Pradesh', lat: 17.7, lng: 83.3, riskFactor: 'high' },
  { name: 'Tamil Nadu Coast', state: 'Tamil Nadu', lat: 13.1, lng: 80.3, riskFactor: 'moderate' },
  { name: 'Punjab Plains', state: 'Punjab', lat: 31.5, lng: 74.5, riskFactor: 'low' },
  { name: 'Haryana Plains', state: 'Haryana', lat: 29.0, lng: 76.5, riskFactor: 'low' },
  { name: 'Rajasthan East', state: 'Rajasthan', lat: 26.5, lng: 74.5, riskFactor: 'low' },
  { name: 'Chambal Basin', state: 'Rajasthan', lat: 26.5, lng: 77.5, riskFactor: 'moderate' },
  { name: 'Tungabhadra Basin', state: 'Karnataka', lat: 15.3, lng: 76.5, riskFactor: 'moderate' },
  { name: 'Luni Basin', state: 'Rajasthan', lat: 25.5, lng: 72.0, riskFactor: 'low' },
  { name: 'Ghaghara Basin', state: 'Uttar Pradesh', lat: 27.5, lng: 81.0, riskFactor: 'high' },
  { name: 'Gandak Basin', state: 'Bihar', lat: 26.8, lng: 85.2, riskFactor: 'high' },
  { name: 'Son Basin', state: 'Bihar', lat: 24.8, lng: 84.2, riskFactor: 'moderate' },
  { name: 'Pennar Basin', state: 'Andhra Pradesh', lat: 14.5, lng: 79.0, riskFactor: 'low' },
  { name: 'Sabarmati Basin', state: 'Gujarat', lat: 23.0, lng: 72.5, riskFactor: 'low' },
  { name: 'Mahi Basin', state: 'Gujarat', lat: 22.8, lng: 73.5, riskFactor: 'moderate' },
  { name: 'Wardha Basin', state: 'Maharashtra', lat: 20.5, lng: 78.5, riskFactor: 'moderate' },
  { name: 'Wainganga Basin', state: 'Maharashtra', lat: 21.5, lng: 79.5, riskFactor: 'moderate' },
  { name: 'Indravati Basin', state: 'Chhattisgarh', lat: 19.5, lng: 81.5, riskFactor: 'moderate' },
  { name: 'Hirakud Dam Area', state: 'Odisha', lat: 21.5, lng: 84.0, riskFactor: 'high' },
  { name: 'Damodar Basin', state: 'Jharkhand', lat: 23.7, lng: 86.9, riskFactor: 'high' },
  { name: 'Subarnarekha Basin', state: 'Jharkhand', lat: 22.8, lng: 86.5, riskFactor: 'moderate' },
  { name: 'Kangsabati Basin', state: 'West Bengal', lat: 22.9, lng: 87.2, riskFactor: 'low' },
  { name: 'Irrawaddy Basin', state: 'Manipur', lat: 24.8, lng: 93.9, riskFactor: 'moderate' },
  { name: 'Surma Valley', state: 'Meghalaya', lat: 25.5, lng: 91.0, riskFactor: 'high' },
  { name: 'Gumti Basin', state: 'Tripura', lat: 23.8, lng: 91.5, riskFactor: 'moderate' },
  { name: 'Kaladan Basin', state: 'Mizoram', lat: 22.6, lng: 92.9, riskFactor: 'moderate' },
  { name: 'Chindwin Basin', state: 'Nagaland', lat: 25.7, lng: 94.1, riskFactor: 'low' },
  { name: 'Dibang Valley', state: 'Arunachal Pradesh', lat: 28.7, lng: 95.9, riskFactor: 'moderate' },
  { name: 'Lohit Basin', state: 'Arunachal Pradesh', lat: 27.8, lng: 96.2, riskFactor: 'high' },
  { name: 'Subansiri Basin', state: 'Arunachal Pradesh', lat: 27.5, lng: 94.2, riskFactor: 'high' },
  { name: 'Siang Basin', state: 'Arunachal Pradesh', lat: 28.0, lng: 95.0, riskFactor: 'high' },
  { name: 'Kameng Basin', state: 'Arunachal Pradesh', lat: 27.0, lng: 92.5, riskFactor: 'moderate' },
  { name: 'Manas Basin', state: 'Assam', lat: 26.8, lng: 91.0, riskFactor: 'high' },
  { name: 'Pagladiya Basin', state: 'Assam', lat: 26.5, lng: 91.3, riskFactor: 'high' },
  { name: 'Puthimari Basin', state: 'Assam', lat: 26.2, lng: 91.5, riskFactor: 'high' },
  { name: 'Kopili Basin', state: 'Assam', lat: 25.5, lng: 92.5, riskFactor: 'high' },
  { name: 'Umngot Basin', state: 'Meghalaya', lat: 25.2, lng: 91.7, riskFactor: 'moderate' },
  { name: 'Kolar Dam Area', state: 'Madhya Pradesh', lat: 23.2, lng: 77.0, riskFactor: 'moderate' },
  { name: 'Upper Vaitarna', state: 'Maharashtra', lat: 19.8, lng: 73.5, riskFactor: 'moderate' },
  { name: 'Bhatsa Dam Area', state: 'Maharashtra', lat: 19.5, lng: 73.4, riskFactor: 'moderate' },
  { name: 'Wilson Dam Area', state: 'Maharashtra', lat: 19.5, lng: 73.8, riskFactor: 'high' },
  { name: 'Mula-Mutha Basin', state: 'Maharashtra', lat: 18.5, lng: 73.9, riskFactor: 'moderate' },
  { name: 'Pavana Dam Area', state: 'Maharashtra', lat: 18.7, lng: 73.5, riskFactor: 'moderate' },
  { name: 'Mulshi Dam Area', state: 'Maharashtra', lat: 18.5, lng: 73.4, riskFactor: 'moderate' },
  { name: 'Bhima Basin', state: 'Maharashtra', lat: 18.2, lng: 74.5, riskFactor: 'high' },
  { name: 'Sina Basin', state: 'Maharashtra', lat: 18.0, lng: 75.0, riskFactor: 'moderate' },
  { name: 'Manjira Basin', state: 'Telangana', lat: 18.2, lng: 77.8, riskFactor: 'moderate' },
  { name: 'Godavari - Hyderabad', state: 'Telangana', lat: 17.4, lng: 78.5, riskFactor: 'high' },
  { name: 'Krishna - Vijayawada', state: 'Andhra Pradesh', lat: 16.5, lng: 80.6, riskFactor: 'high' },
  { name: 'Penna Basin', state: 'Andhra Pradesh', lat: 14.5, lng: 79.0, riskFactor: 'low' },
  { name: 'Kaveri - Mysore', state: 'Karnataka', lat: 12.3, lng: 76.6, riskFactor: 'low' },
  { name: 'Kaveri - Bangalore', state: 'Karnataka', lat: 12.9, lng: 77.6, riskFactor: 'moderate' },
  { name: 'Tunga Basin', state: 'Karnataka', lat: 13.9, lng: 75.6, riskFactor: 'moderate' },
  { name: 'Sharavati Basin', state: 'Karnataka', lat: 14.2, lng: 74.7, riskFactor: 'low' },
  { name: 'Kali Basin', state: 'Karnataka', lat: 14.8, lng: 74.4, riskFactor: 'moderate' },
  { name: 'Ghataprabha Basin', state: 'Karnataka', lat: 16.2, lng: 75.0, riskFactor: 'moderate' },
  { name: 'Malaprabha Basin', state: 'Karnataka', lat: 15.9, lng: 75.2, riskFactor: 'moderate' },
  { name: 'Palar Basin', state: 'Tamil Nadu', lat: 12.8, lng: 79.7, riskFactor: 'low' },
  { name: 'Vaigai Basin', state: 'Tamil Nadu', lat: 9.9, lng: 78.1, riskFactor: 'low' },
  { name: 'Thamirabarani Basin', state: 'Tamil Nadu', lat: 8.6, lng: 77.9, riskFactor: 'low' },
  { name: 'Kollidam Basin', state: 'Tamil Nadu', lat: 11.1, lng: 79.7, riskFactor: 'moderate' },
  { name: 'Vellar Basin', state: 'Tamil Nadu', lat: 11.3, lng: 79.7, riskFactor: 'low' },
  { name: 'Vedavathi Basin', state: 'Karnataka', lat: 14.5, lng: 76.5, riskFactor: 'low' },
  { name: 'Ponnaiyar Basin', state: 'Tamil Nadu', lat: 12.0, lng: 79.2, riskFactor: 'low' },
  { name: 'Cheyyar Basin', state: 'Tamil Nadu', lat: 12.7, lng: 79.5, riskFactor: 'low' },
  { name: 'Araniyar Basin', state: 'Tamil Nadu', lat: 13.3, lng: 80.0, riskFactor: 'moderate' },
  { name: 'Kosasthalaiyar Basin', state: 'Tamil Nadu', lat: 13.4, lng: 80.2, riskFactor: 'moderate' },
  { name: 'Adyar Basin', state: 'Tamil Nadu', lat: 13.0, lng: 80.2, riskFactor: 'moderate' },
  { name: 'Cooum Basin', state: 'Tamil Nadu', lat: 13.1, lng: 80.3, riskFactor: 'high' },
  { name: 'Buckingham Canal', state: 'Tamil Nadu', lat: 13.2, lng: 80.3, riskFactor: 'high' },
  { name: 'Ennore Creek', state: 'Tamil Nadu', lat: 13.2, lng: 80.3, riskFactor: 'moderate' },
  { name: 'Pulicat Lake', state: 'Andhra Pradesh', lat: 13.6, lng: 80.2, riskFactor: 'low' },
  { name: 'Chilika Lake', state: 'Odisha', lat: 19.7, lng: 85.4, riskFactor: 'moderate' },
  { name: 'Kolleru Lake', state: 'Andhra Pradesh', lat: 16.6, lng: 81.2, riskFactor: 'high' },
  { name: 'Pulicat - Andhra Side', state: 'Andhra Pradesh', lat: 13.7, lng: 80.2, riskFactor: 'moderate' },
  { name: 'Coringa Wildlife', state: 'Andhra Pradesh', lat: 16.8, lng: 82.3, riskFactor: 'moderate' },
  { name: 'Godavari - Rajahmundry', state: 'Andhra Pradesh', lat: 17.0, lng: 81.8, riskFactor: 'high' },
  { name: 'Polavaram Dam Area', state: 'Andhra Pradesh', lat: 17.3, lng: 81.6, riskFactor: 'high' },
  { name: 'Papikondalu', state: 'Andhra Pradesh', lat: 17.4, lng: 81.5, riskFactor: 'high' },
  { name: 'Alamatti Dam Area', state: 'Karnataka', lat: 16.3, lng: 75.9, riskFactor: 'moderate' },
  { name: 'Narayanpur Dam', state: 'Karnataka', lat: 16.1, lng: 76.0, riskFactor: 'moderate' },
  { name: 'Tungabhadra Dam', state: 'Karnataka', lat: 15.3, lng: 76.5, riskFactor: 'moderate' },
  { name: 'Srisailam Dam', state: 'Andhra Pradesh', lat: 16.1, lng: 78.9, riskFactor: 'high' },
  { name: 'Nagarjuna Sagar', state: 'Telangana', lat: 16.6, lng: 79.3, riskFactor: 'high' },
  { name: 'Pulichintala', state: 'Andhra Pradesh', lat: 16.8, lng: 80.1, riskFactor: 'high' },
  { name: 'Prakasam Barrage', state: 'Andhra Pradesh', lat: 16.5, lng: 80.6, riskFactor: 'high' },
  { name: 'Hamsaladeevi', state: 'Andhra Pradesh', lat: 15.8, lng: 80.9, riskFactor: 'moderate' },
  { name: 'Machilipatnam Coast', state: 'Andhra Pradesh', lat: 16.2, lng: 81.1, riskFactor: 'high' },
  { name: 'Visakhapatnam Coast', state: 'Andhra Pradesh', lat: 17.7, lng: 83.3, riskFactor: 'high' },
  { name: 'Kakinada Coast', state: 'Andhra Pradesh', lat: 17.0, lng: 82.2, riskFactor: 'moderate' },
  { name: 'Bhimavaram Area', state: 'Andhra Pradesh', lat: 16.5, lng: 81.5, riskFactor: 'moderate' },
  { name: 'Eluru Area', state: 'Andhra Pradesh', lat: 16.7, lng: 81.1, riskFactor: 'moderate' },
  { name: 'Guntur Area', state: 'Andhra Pradesh', lat: 16.3, lng: 80.4, riskFactor: 'moderate' },
  { name: 'Nellore Coast', state: 'Andhra Pradesh', lat: 14.4, lng: 79.9, riskFactor: 'high' },
  { name: 'Tada Falls Area', state: 'Andhra Pradesh', lat: 13.6, lng: 79.9, riskFactor: 'moderate' },
  { name: 'Chennai - Adyar', state: 'Tamil Nadu', lat: 13.0, lng: 80.2, riskFactor: 'high' },
  { name: 'Chennai - Cooum', state: 'Tamil Nadu', lat: 13.1, lng: 80.3, riskFactor: 'high' },
  { name: 'Chennai - Ennore', state: 'Tamil Nadu', lat: 13.2, lng: 80.3, riskFactor: 'moderate' },
  { name: 'Chennai - Kosasthalaiyar', state: 'Tamil Nadu', lat: 13.3, lng: 80.2, riskFactor: 'moderate' },
  { name: 'Kancheepuram', state: 'Tamil Nadu', lat: 12.8, lng: 79.7, riskFactor: 'moderate' },
  { name: 'Tiruvallur', state: 'Tamil Nadu', lat: 13.1, lng: 79.9, riskFactor: 'moderate' },
  { name: 'Cuddalore', state: 'Tamil Nadu', lat: 11.7, lng: 79.8, riskFactor: 'high' },
  { name: 'Nagapattinam', state: 'Tamil Nadu', lat: 10.8, lng: 79.8, riskFactor: 'high' },
  { name: 'Thanjavur', state: 'Tamil Nadu', lat: 10.8, lng: 79.1, riskFactor: 'moderate' },
  { name: 'Pudukkottai', state: 'Tamil Nadu', lat: 10.4, lng: 78.8, riskFactor: 'low' },
  { name: 'Ramanathapuram', state: 'Tamil Nadu', lat: 9.4, lng: 78.8, riskFactor: 'low' },
  { name: 'Thoothukudi', state: 'Tamil Nadu', lat: 8.8, lng: 78.1, riskFactor: 'moderate' },
  { name: 'Kanyakumari', state: 'Tamil Nadu', lat: 8.1, lng: 77.5, riskFactor: 'high' },
  { name: 'Kollam', state: 'Kerala', lat: 8.9, lng: 76.6, riskFactor: 'high' },
  { name: 'Alappuzha', state: 'Kerala', lat: 9.5, lng: 76.3, riskFactor: 'high' },
  { name: 'Kochi', state: 'Kerala', lat: 9.9, lng: 76.3, riskFactor: 'high' },
  { name: 'Thrissur', state: 'Kerala', lat: 10.5, lng: 76.2, riskFactor: 'high' },
  { name: 'Malappuram', state: 'Kerala', lat: 11.0, lng: 76.1, riskFactor: 'high' },
  { name: 'Kozhikode', state: 'Kerala', lat: 11.3, lng: 75.8, riskFactor: 'moderate' },
  { name: 'Kannur', state: 'Kerala', lat: 11.9, lng: 75.4, riskFactor: 'moderate' },
  { name: 'Kasaragod', state: 'Kerala', lat: 12.5, lng: 75.0, riskFactor: 'moderate' },
  { name: 'Palakkad', state: 'Kerala', lat: 10.8, lng: 76.7, riskFactor: 'high' },
  { name: 'Idukki', state: 'Kerala', lat: 9.8, lng: 76.9, riskFactor: 'high' },
  { name: 'Wayanad', state: 'Kerala', lat: 11.7, lng: 76.0, riskFactor: 'high' },
  { name: 'Ernakulam', state: 'Kerala', lat: 10.0, lng: 76.3, riskFactor: 'high' },
  { name: 'Pathanamthitta', state: 'Kerala', lat: 9.3, lng: 76.8, riskFactor: 'high' },
  { name: 'Kottayam', state: 'Kerala', lat: 9.6, lng: 76.5, riskFactor: 'high' },
  { name: 'Mangalore', state: 'Karnataka', lat: 12.9, lng: 74.9, riskFactor: 'high' },
  { name: 'Udupi', state: 'Karnataka', lat: 13.3, lng: 74.7, riskFactor: 'moderate' },
  { name: 'Karwar', state: 'Karnataka', lat: 14.8, lng: 74.1, riskFactor: 'moderate' },
  { name: 'Gokarna', state: 'Karnataka', lat: 14.5, lng: 74.3, riskFactor: 'low' },
  { name: 'Bhatkal', state: 'Karnataka', lat: 13.9, lng: 74.6, riskFactor: 'moderate' },
  { name: 'Honnavar', state: 'Karnataka', lat: 14.3, lng: 74.4, riskFactor: 'moderate' },
  { name: 'Kumta', state: 'Karnataka', lat: 14.4, lng: 74.4, riskFactor: 'moderate' },
  { name: 'Goa - Panaji', state: 'Goa', lat: 15.5, lng: 73.8, riskFactor: 'moderate' },
  { name: 'Goa - Vasco', state: 'Goa', lat: 15.4, lng: 73.8, riskFactor: 'moderate' },
  { name: 'Goa - Margao', state: 'Goa', lat: 15.3, lng: 73.9, riskFactor: 'moderate' },
  { name: 'Ratnagiri', state: 'Maharashtra', lat: 16.9, lng: 73.3, riskFactor: 'high' },
  { name: 'Sindhudurg', state: 'Maharashtra', lat: 16.0, lng: 73.5, riskFactor: 'high' },
  { name: 'Raigad', state: 'Maharashtra', lat: 18.6, lng: 73.0, riskFactor: 'high' },
  { name: 'Thane Coastal', state: 'Maharashtra', lat: 19.2, lng: 72.9, riskFactor: 'high' },
  { name: 'Palghar', state: 'Maharashtra', lat: 19.7, lng: 72.8, riskFactor: 'high' },
  { name: 'Daman', state: 'Daman and Diu', lat: 20.4, lng: 72.8, riskFactor: 'moderate' },
  { name: 'Diu', state: 'Daman and Diu', lat: 20.7, lng: 70.9, riskFactor: 'low' },
  { name: 'Valsad', state: 'Gujarat', lat: 20.6, lng: 72.9, riskFactor: 'moderate' },
  { name: 'Navsari', state: 'Gujarat', lat: 20.9, lng: 72.9, riskFactor: 'moderate' },
  { name: 'Surat', state: 'Gujarat', lat: 21.2, lng: 72.8, riskFactor: 'high' },
  { name: 'Bharuch', state: 'Gujarat', lat: 21.7, lng: 72.9, riskFactor: 'high' },
  { name: 'Vadodara', state: 'Gujarat', lat: 22.3, lng: 73.2, riskFactor: 'moderate' },
  { name: 'Anand', state: 'Gujarat', lat: 22.6, lng: 72.9, riskFactor: 'low' },
  { name: 'Kheda', state: 'Gujarat', lat: 22.8, lng: 72.7, riskFactor: 'low' },
  { name: 'Ahmedabad', state: 'Gujarat', lat: 23.0, lng: 72.6, riskFactor: 'moderate' },
  { name: 'Gandhinagar', state: 'Gujarat', lat: 23.2, lng: 72.6, riskFactor: 'low' },
  { name: 'Mehsana', state: 'Gujarat', lat: 23.6, lng: 72.4, riskFactor: 'low' },
  { name: 'Patan', state: 'Gujarat', lat: 23.8, lng: 72.1, riskFactor: 'low' },
  { name: 'Banaskantha', state: 'Gujarat', lat: 24.2, lng: 72.4, riskFactor: 'low' },
  { name: 'Sabarkantha', state: 'Gujarat', lat: 23.6, lng: 73.0, riskFactor: 'low' },
  { name: 'Aravalli', state: 'Gujarat', lat: 23.4, lng: 73.3, riskFactor: 'low' },
  { name: 'Dahod', state: 'Gujarat', lat: 22.8, lng: 74.3, riskFactor: 'low' },
  { name: 'Panchmahal', state: 'Gujarat', lat: 22.7, lng: 73.6, riskFactor: 'low' },
  { name: 'Mahisagar', state: 'Gujarat', lat: 23.2, lng: 73.6, riskFactor: 'low' },
  { name: 'Chhota Udaipur', state: 'Gujarat', lat: 22.3, lng: 74.0, riskFactor: 'low' },
  { name: 'Narmada', state: 'Gujarat', lat: 21.9, lng: 73.5, riskFactor: 'moderate' },
  { name: 'Bharuch - Narmada', state: 'Gujarat', lat: 21.7, lng: 72.9, riskFactor: 'high' },
  { name: 'Tapi Basin', state: 'Gujarat', lat: 21.0, lng: 73.7, riskFactor: 'moderate' },
  { name: 'Surat - Tapi', state: 'Gujarat', lat: 21.2, lng: 72.8, riskFactor: 'high' },
  { name: 'Navsari - Coastal', state: 'Gujarat', lat: 20.9, lng: 72.9, riskFactor: 'moderate' },
  { name: 'Valsad - Coastal', state: 'Gujarat', lat: 20.6, lng: 72.9, riskFactor: 'moderate' },
  { name: 'Dang', state: 'Gujarat', lat: 20.8, lng: 73.5, riskFactor: 'high' },
  { name: 'Vapi', state: 'Gujarat', lat: 20.4, lng: 72.9, riskFactor: 'moderate' },
  { name: 'Porbandar', state: 'Gujarat', lat: 21.6, lng: 69.6, riskFactor: 'moderate' },
  { name: 'Jamnagar', state: 'Gujarat', lat: 22.5, lng: 70.1, riskFactor: 'moderate' },
  { name: 'Rajkot', state: 'Gujarat', lat: 22.3, lng: 70.8, riskFactor: 'low' },
  { name: 'Bhavnagar', state: 'Gujarat', lat: 21.8, lng: 72.1, riskFactor: 'moderate' },
  { name: 'Amreli', state: 'Gujarat', lat: 21.6, lng: 71.2, riskFactor: 'low' },
  { name: 'Junagadh', state: 'Gujarat', lat: 21.5, lng: 70.5, riskFactor: 'low' },
  { name: 'Gir Somnath', state: 'Gujarat', lat: 20.9, lng: 70.4, riskFactor: 'low' },
  { name: 'Surendranagar', state: 'Gujarat', lat: 22.7, lng: 71.6, riskFactor: 'low' },
  { name: 'Morbi', state: 'Gujarat', lat: 22.8, lng: 70.8, riskFactor: 'low' },
  { name: 'Kutch', state: 'Gujarat', lat: 23.3, lng: 69.7, riskFactor: 'low' },
  { name: 'Bhuj', state: 'Gujarat', lat: 23.2, lng: 69.7, riskFactor: 'low' },
  { name: 'Mandvi', state: 'Gujarat', lat: 22.8, lng: 69.4, riskFactor: 'low' },
  { name: 'Mundra', state: 'Gujarat', lat: 22.8, lng: 69.7, riskFactor: 'low' },
  { name: 'Anjar', state: 'Gujarat', lat: 23.1, lng: 70.0, riskFactor: 'low' },
  { name: 'Bhachau', state: 'Gujarat', lat: 23.3, lng: 70.3, riskFactor: 'low' },
  { name: 'Rapar', state: 'Gujarat', lat: 23.6, lng: 70.6, riskFactor: 'low' },
  { name: 'Gandhidham', state: 'Gujarat', lat: 23.1, lng: 70.1, riskFactor: 'low' },
  { name: 'Adipur', state: 'Gujarat', lat: 23.1, lng: 70.0, riskFactor: 'low' },
  { name: 'Udaipur - Rajasthan', state: 'Rajasthan', lat: 24.6, lng: 73.7, riskFactor: 'low' },
  { name: 'Jaipur', state: 'Rajasthan', lat: 26.9, lng: 75.8, riskFactor: 'low' },
  { name: 'Jodhpur', state: 'Rajasthan', lat: 26.2, lng: 73.0, riskFactor: 'low' },
  { name: 'Kota', state: 'Rajasthan', lat: 25.2, lng: 75.8, riskFactor: 'low' },
  { name: 'Bikaner', state: 'Rajasthan', lat: 28.0, lng: 73.3, riskFactor: 'low' },
  { name: 'Ajmer', state: 'Rajasthan', lat: 26.4, lng: 74.6, riskFactor: 'low' },
  { name: 'Udaipur', state: 'Rajasthan', lat: 24.6, lng: 73.7, riskFactor: 'low' },
  { name: 'Bhilwara', state: 'Rajasthan', lat: 25.3, lng: 74.6, riskFactor: 'low' },
  { name: 'Sikar', state: 'Rajasthan', lat: 27.6, lng: 75.1, riskFactor: 'low' },
  { name: 'Alwar', state: 'Rajasthan', lat: 27.6, lng: 76.6, riskFactor: 'low' },
  { name: 'Bharatpur', state: 'Rajasthan', lat: 27.2, lng: 77.5, riskFactor: 'low' },
  { name: 'Pali', state: 'Rajasthan', lat: 25.8, lng: 73.3, riskFactor: 'low' },
  { name: 'Barmer', state: 'Rajasthan', lat: 25.7, lng: 71.4, riskFactor: 'low' },
  { name: 'Jaisalmer', state: 'Rajasthan', lat: 26.9, lng: 70.9, riskFactor: 'low' },
  { name: 'Jalore', state: 'Rajasthan', lat: 25.3, lng: 72.6, riskFactor: 'low' },
  { name: 'Sirohi', state: 'Rajasthan', lat: 24.9, lng: 72.9, riskFactor: 'low' },
  { name: 'Chittorgarh', state: 'Rajasthan', lat: 24.9, lng: 74.6, riskFactor: 'low' },
  { name: 'Banswara', state: 'Rajasthan', lat: 23.5, lng: 74.4, riskFactor: 'low' },
  { name: 'Dungarpur', state: 'Rajasthan', lat: 23.8, lng: 73.7, riskFactor: 'low' },
  { name: 'Pratapgarh', state: 'Rajasthan', lat: 24.0, lng: 74.8, riskFactor: 'low' },
  { name: 'Rajsamand', state: 'Rajasthan', lat: 25.1, lng: 73.9, riskFactor: 'low' },
  { name: 'Nagaur', state: 'Rajasthan', lat: 27.2, lng: 73.7, riskFactor: 'low' },
  { name: 'Jhunjhunu', state: 'Rajasthan', lat: 28.1, lng: 75.4, riskFactor: 'low' },
  { name: 'Churu', state: 'Rajasthan', lat: 28.3, lng: 74.9, riskFactor: 'low' },
  { name: 'Hanumangarh', state: 'Rajasthan', lat: 29.6, lng: 74.3, riskFactor: 'low' },
  { name: 'Sri Ganganagar', state: 'Rajasthan', lat: 29.9, lng: 73.9, riskFactor: 'low' },
  { name: 'Bundi', state: 'Rajasthan', lat: 25.4, lng: 75.6, riskFactor: 'low' },
  { name: 'Sawai Madhopur', state: 'Rajasthan', lat: 26.0, lng: 76.4, riskFactor: 'low' },
  { name: 'Tonk', state: 'Rajasthan', lat: 26.2, lng: 75.8, riskFactor: 'low' },
  { name: 'Jhalawar', state: 'Rajasthan', lat: 24.6, lng: 76.2, riskFactor: 'low' },
  { name: 'Baran', state: 'Rajasthan', lat: 25.1, lng: 76.5, riskFactor: 'low' },
  { name: 'Karauli', state: 'Rajasthan', lat: 26.5, lng: 77.0, riskFactor: 'low' },
  { name: 'Dholpur', state: 'Rajasthan', lat: 26.7, lng: 77.9, riskFactor: 'low' },
  { name: 'Dausa', state: 'Rajasthan', lat: 26.9, lng: 76.3, riskFactor: 'low' },
  { name: 'Dhaulpur', state: 'Rajasthan', lat: 26.7, lng: 77.9, riskFactor: 'low' },
  { name: 'Morena', state: 'Madhya Pradesh', lat: 26.5, lng: 78.0, riskFactor: 'low' },
  { name: 'Bhind', state: 'Madhya Pradesh', lat: 26.6, lng: 78.8, riskFactor: 'low' },
  { name: 'Gwalior', state: 'Madhya Pradesh', lat: 26.2, lng: 78.2, riskFactor: 'low' },
  { name: 'Datia', state: 'Madhya Pradesh', lat: 25.7, lng: 78.5, riskFactor: 'low' },
  { name: 'Shivpuri', state: 'Madhya Pradesh', lat: 25.4, lng: 77.7, riskFactor: 'low' },
  { name: 'Guna', state: 'Madhya Pradesh', lat: 24.6, lng: 77.3, riskFactor: 'low' },
  { name: 'Ashoknagar', state: 'Madhya Pradesh', lat: 24.6, lng: 77.7, riskFactor: 'low' },
  { name: 'Tikamgarh', state: 'Madhya Pradesh', lat: 24.7, lng: 78.8, riskFactor: 'low' },
  { name: 'Chhatarpur', state: 'Madhya Pradesh', lat: 24.9, lng: 79.6, riskFactor: 'low' },
  { name: 'Panna', state: 'Madhya Pradesh', lat: 24.7, lng: 80.2, riskFactor: 'low' },
  { name: 'Satna', state: 'Madhya Pradesh', lat: 24.6, lng: 80.8, riskFactor: 'low' },
  { name: 'Rewa', state: 'Madhya Pradesh', lat: 24.5, lng: 81.3, riskFactor: 'low' },
  { name: 'Sidhi', state: 'Madhya Pradesh', lat: 24.4, lng: 81.9, riskFactor: 'low' },
  { name: 'Singrauli', state: 'Madhya Pradesh', lat: 24.2, lng: 82.7, riskFactor: 'low' },
  { name: 'Shahdol', state: 'Madhya Pradesh', lat: 23.3, lng: 81.4, riskFactor: 'moderate' },
  { name: 'Umaria', state: 'Madhya Pradesh', lat: 23.5, lng: 80.8, riskFactor: 'moderate' },
  { name: 'Katni', state: 'Madhya Pradesh', lat: 23.8, lng: 80.4, riskFactor: 'low' },
  { name: 'Jabalpur', state: 'Madhya Pradesh', lat: 23.2, lng: 79.9, riskFactor: 'moderate' },
  { name: 'Narsinghpur', state: 'Madhya Pradesh', lat: 22.9, lng: 79.2, riskFactor: 'moderate' },
  { name: 'Mandla', state: 'Madhya Pradesh', lat: 22.6, lng: 80.4, riskFactor: 'moderate' },
  { name: 'Dindori', state: 'Madhya Pradesh', lat: 22.8, lng: 81.8, riskFactor: 'moderate' },
  { name: 'Seoni', state: 'Madhya Pradesh', lat: 22.1, lng: 79.5, riskFactor: 'moderate' },
  { name: 'Chhindwara', state: 'Madhya Pradesh', lat: 22.1, lng: 78.9, riskFactor: 'moderate' },
  { name: 'Betul', state: 'Madhya Pradesh', lat: 21.9, lng: 77.9, riskFactor: 'low' },
  { name: 'Hoshangabad', state: 'Madhya Pradesh', lat: 22.7, lng: 77.7, riskFactor: 'moderate' },
  { name: 'Raisen', state: 'Madhya Pradesh', lat: 23.3, lng: 78.0, riskFactor: 'low' },
  { name: 'Vidisha', state: 'Madhya Pradesh', lat: 23.5, lng: 77.8, riskFactor: 'low' },
  { name: 'Bhopal', state: 'Madhya Pradesh', lat: 23.3, lng: 77.4, riskFactor: 'moderate' },
  { name: 'Sehore', state: 'Madhya Pradesh', lat: 23.2, lng: 77.1, riskFactor: 'low' },
  { name: 'Rajgarh', state: 'Madhya Pradesh', lat: 24.0, lng: 76.7, riskFactor: 'low' },
  { name: 'Shajapur', state: 'Madhya Pradesh', lat: 23.4, lng: 76.3, riskFactor: 'low' },
  { name: 'Agar Malwa', state: 'Madhya Pradesh', lat: 23.7, lng: 76.0, riskFactor: 'low' },
  { name: 'Dewas', state: 'Madhya Pradesh', lat: 22.9, lng: 76.1, riskFactor: 'low' },
  { name: 'Indore', state: 'Madhya Pradesh', lat: 22.7, lng: 75.9, riskFactor: 'low' },
  { name: 'Dhar', state: 'Madhya Pradesh', lat: 22.6, lng: 75.3, riskFactor: 'low' },
  { name: 'Jhabua', state: 'Madhya Pradesh', lat: 22.8, lng: 74.6, riskFactor: 'low' },
  { name: 'Alirajpur', state: 'Madhya Pradesh', lat: 22.3, lng: 74.4, riskFactor: 'low' },
  { name: 'Barwani', state: 'Madhya Pradesh', lat: 22.0, lng: 74.9, riskFactor: 'low' },
  { name: 'Khargone', state: 'Madhya Pradesh', lat: 21.8, lng: 75.6, riskFactor: 'low' },
  { name: 'Khandwa', state: 'Madhya Pradesh', lat: 21.8, lng: 76.3, riskFactor: 'low' },
  { name: 'Burhanpur', state: 'Madhya Pradesh', lat: 21.3, lng: 76.2, riskFactor: 'low' },
  { name: 'Ujjain', state: 'Madhya Pradesh', lat: 23.2, lng: 75.8, riskFactor: 'low' },
  { name: 'Ratlam', state: 'Madhya Pradesh', lat: 23.5, lng: 75.1, riskFactor: 'low' },
  { name: 'Mandsaur', state: 'Madhya Pradesh', lat: 24.1, lng: 75.1, riskFactor: 'low' },
  { name: 'Neemuch', state: 'Madhya Pradesh', lat: 24.5, lng: 74.9, riskFactor: 'low' },
  { name: 'Shivpuri', state: 'Madhya Pradesh', lat: 25.4, lng: 77.7, riskFactor: 'low' },
  { name: 'Sheopur', state: 'Madhya Pradesh', lat: 25.7, lng: 76.7, riskFactor: 'low' },
  { name: 'Anuppur', state: 'Madhya Pradesh', lat: 23.1, lng: 81.7, riskFactor: 'moderate' },
  { name: 'Sagar', state: 'Madhya Pradesh', lat: 23.8, lng: 78.7, riskFactor: 'low' },
  { name: 'Damoh', state: 'Madhya Pradesh', lat: 23.8, lng: 79.4, riskFactor: 'low' },
  { name: 'Harda', state: 'Madhya Pradesh', lat: 22.3, lng: 77.1, riskFactor: 'low' }
];

app.get('/api/alerts/all-india', async (_req, res) => {
  try {
    // Generate alerts based on real-time weather data for flood-prone zones
    const alerts = [];
    
    // Check weather for each zone (limit to avoid API overload)
    const zonesToCheck = allIndiaFloodZones.slice(0, 50); // Check top 50 high-risk zones
    
    for (const zone of zonesToCheck) {
      try {
        // Get weather data
        const wx = await getWeatherNow(zone.lat, zone.lng);
        const rainfall = Number(wx?.precipitationMm) || 0;
        
        // Determine severity based on rainfall and base risk
        let severity = zone.riskFactor;
        let message = `${zone.name}, ${zone.state}: `;
        
        if (rainfall >= 50) {
          severity = 'high';
          message += `Heavy rainfall ${rainfall}mm detected. Severe flood risk. Evacuation may be required.`;
        } else if (rainfall >= 20) {
          severity = severity === 'high' ? 'high' : 'moderate';
          message += `Moderate rainfall ${rainfall}mm. Flood risk elevated.`;
        } else if (rainfall >= 5) {
          message += `Light rainfall ${rainfall}mm. Monitor situation.`;
        } else {
          message += `No significant rainfall. Normal conditions.`;
          // Include all areas, even low risk - they will show as green markers
        }
        
        alerts.push({
          id: `flood-${zone.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
          type: 'flood',
          lat: zone.lat,
          lng: zone.lng,
          severity: severity,
          location: `${zone.name}, ${zone.state}`,
          message: message,
          rainfallMm: rainfall,
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        // If weather fetch fails, use base risk factor
        if (zone.riskFactor !== 'low') {
          alerts.push({
            id: `flood-${zone.name.toLowerCase().replace(/\s+/g, '-')}-base`,
            type: 'flood',
            lat: zone.lat,
            lng: zone.lng,
            severity: zone.riskFactor,
            location: `${zone.name}, ${zone.state}`,
            message: `${zone.name}, ${zone.state}: Historical flood-prone area. Monitor for updates.`,
            rainfallMm: null,
            timestamp: new Date().toISOString()
          });
        }
      }
    }
    
    res.json({ ok: true, count: alerts.length, alerts: alerts });
  } catch (e) {
    console.error('[AllIndia] Error generating alerts:', e);
    // Return fallback alerts if error
    const fallbackAlerts = allIndiaFloodZones
      .slice(0, 50)
      .map(zone => ({
        id: `flood-${zone.name.toLowerCase().replace(/\s+/g, '-')}-fallback`,
        type: 'flood',
        lat: zone.lat,
        lng: zone.lng,
        severity: zone.riskFactor,
        location: `${zone.name}, ${zone.state}`,
        message: `${zone.name}, ${zone.state}: Historical flood-prone zone.`,
        rainfallMm: null,
        timestamp: new Date().toISOString()
      }));
    
    res.json({ ok: true, count: fallbackAlerts.length, fallback: true, alerts: fallbackAlerts });
  }
});

function normalizeEnvSecret(v) {
  const s = String(v ?? '').trim();
  // Allow .env values like "abcd efgh ijkl mnop" or 'abcd...'
  const unquoted = s.replace(/^['"]|['"]$/g, '');
  return unquoted.replace(/\s+/g, '');
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function makeOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPin(pin, salt) {
  return sha256(`${String(pin)}:${String(salt)}`);
}

const OTP_TTL_MS = 2 * 60 * 1000;

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_DB_FILE)) fs.writeFileSync(USERS_DB_FILE, '[]', 'utf8');
  if (!fs.existsSync(ALERTS_DB_FILE)) fs.writeFileSync(ALERTS_DB_FILE, '[]', 'utf8');
}

function readUsersDb() {
  ensureDataFiles();
  try {
    const raw = fs.readFileSync(USERS_DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeUsersDb(users) {
  ensureDataFiles();
  fs.writeFileSync(USERS_DB_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function readAlertsDb() {
  ensureDataFiles();
  try {
    const raw = fs.readFileSync(ALERTS_DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeAlertsDb(alerts) {
  ensureDataFiles();
  fs.writeFileSync(ALERTS_DB_FILE, JSON.stringify(alerts, null, 2), 'utf8');
}

function kmBetween(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Validate admin alert against real-time APIs to prevent fake alerts
async function validateAlertConditions({ type, lat, lng, radiusKm }) {
  try {
    if (type === 'flood') {
      // Fetch weather to verify heavy rainfall exists
      const wx = await getWeatherNow(lat, lng);
      const rain = Number(wx?.precipitationMm);
      if (!Number.isFinite(rain) || rain < 5) {
        return {
          ok: false,
          reason: `No significant rainfall detected (${rain || 0}mm). Flood alerts require at least 5mm precipitation.`,
          data: { precipitationMm: rain, source: wx?.source }
        };
      }
      return { ok: true, reason: 'ok', data: { precipitationMm: rain, source: wx?.source } };
    }

    if (type === 'earthquake') {
      // Check USGS for recent earthquakes in area
      const start = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // last 1 hour
      const url =
        'https://earthquake.usgs.gov/fdsnws/event/1/query' +
        `?format=geojson&latitude=${encodeURIComponent(lat)}` +
        `&longitude=${encodeURIComponent(lng)}` +
        `&maxradiuskm=${encodeURIComponent(Math.max(radiusKm, 50))}` +
        `&starttime=${encodeURIComponent(start)}` +
        '&orderby=time&limit=10';
      const data = await httpsGetJson(url, 10000);
      const features = Array.isArray(data?.features) ? data.features : [];
      const recent = features.filter(f => {
        const mag = Number(f?.properties?.mag);
        return Number.isFinite(mag) && mag >= 3.0;
      });
      if (recent.length === 0) {
        return {
          ok: false,
          reason: 'No recent earthquakes (M3.0+) detected in this area (last 1 hour).',
          data: { count: 0 }
        };
      }
      const maxMag = Math.max(...recent.map(f => Number(f?.properties?.mag)));
      return { ok: true, reason: 'ok', data: { count: recent.length, maxMagnitude: maxMag } };
    }

    if (type === 'tsunami') {
      // Tsunami usually follows significant earthquake (M6.5+) nearby
      const start = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // last 3 hours
      const url =
        'https://earthquake.usgs.gov/fdsnws/event/1/query' +
        `?format=geojson&latitude=${encodeURIComponent(lat)}` +
        `&longitude=${encodeURIComponent(lng)}` +
        `&maxradiuskm=${encodeURIComponent(Math.max(radiusKm * 2, 200))}` + // wider radius for tsunami
        `&starttime=${encodeURIComponent(start)}` +
        '&orderby=time&limit=10';
      const data = await httpsGetJson(url, 10000);
      const features = Array.isArray(data?.features) ? data.features : [];
      const significant = features.filter(f => {
        const mag = Number(f?.properties?.mag);
        return Number.isFinite(mag) && mag >= 6.5; // significant for tsunami
      });
      if (significant.length === 0) {
        return {
          ok: false,
          reason: 'No significant earthquakes (M6.5+) detected nearby (last 3 hours) that could trigger tsunami.',
          data: { count: 0 }
        };
      }
      const maxMag = Math.max(...significant.map(f => Number(f?.properties?.mag)));
      return { ok: true, reason: 'ok', data: { count: significant.length, maxMagnitude: maxMag } };
    }

    return { ok: true, reason: 'unknown type - no validation' };
  } catch (e) {
    // If validation fails due to API error, allow alert with warning
    return { ok: true, reason: 'validation-error-allowed', error: String(e?.message || e) };
  }
}

function activeAlertsNow() {
  const now = Date.now();
  return readAlertsDb().filter(a => {
    if (!a) return false;
    const exp = a.expiresAt ? new Date(a.expiresAt).getTime() : NaN;
    if (!Number.isFinite(exp)) return true;
    return exp > now;
  });
}

function upsertUser(user) {
  const users = readUsersDb();
  const id = String(user?.id || '').trim();
  const phone = String(user?.phone || '').trim();

  const idx = users.findIndex(u => (id && String(u?.id) === id) || (phone && String(u?.phone) === phone));
  if (idx >= 0) {
    users[idx] = { ...users[idx], ...user, id: users[idx].id || user.id };
  } else {
    users.unshift(user);
  }
  writeUsersDb(users);
  return users;
}

const sseClients = new Set();
function sseSend(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      // ignore broken client
    }
  }
}

// In-memory OTP store (demo). In production use DB/Redis.
// key = email|phone, value = { otpHash, expiresAt, attempts }
const otpStore = new Map();

function otpKey(email, phone) {
  return `${String(email || '').trim().toLowerCase()}|${String(phone || '').trim()}`;
}

function transporter() {
  const user = requiredEnv('GMAIL_USER');
  const pass = normalizeEnvSecret(requiredEnv('GMAIL_APP_PASSWORD'));

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

async function sendOtpEmail({ to, name, phone, otp }) {
  const user = requiredEnv('GMAIL_USER');
  const tx = transporter();

  const subject = 'NDMS Verification Code (OTP)';
  const text =
    `National Disaster Management System (NDMS)\n` +
    `Verification Code (OTP): ${otp}\n\n` +
    `Requested for: ${name || 'Citizen'}\n` +
    `Phone: +91 ${phone || ''}\n\n` +
    `This code expires in 2 minutes.\n` +
    `If you did not request this OTP, ignore this email.\n` +
    `\n⚠️ Simulation/Demo Project`;

  await tx.sendMail({
    from: `NDMS OTP <${user}>`,
    to,
    subject,
    text,
  });
}

function allowDevOtp() {
  const v = String(process.env.ALLOW_DEV_OTP || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

async function sendAlertEmail({ to, subject, text, severity }) {
  const user = requiredEnv('GMAIL_USER');
  const tx = transporter();
  const sev = String(severity || '').trim().toLowerCase();
  const high = sev === 'high';
  await tx.sendMail({
    from: `NDMS Alerts <${user}>`,
    to,
    subject: high ? `🔴 URGENT: ${subject}` : subject,
    text,
    headers: high
      ? {
          'X-Priority': '1 (Highest)',
          'X-MSMail-Priority': 'High',
          Importance: 'High'
        }
      : undefined,
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/admin/auto-alerts/status', (_req, res) => {
  res.json({
    ok: true,
    enabled: !!autoAlertState.enabled,
    intervalMs: AUTO_ALERT_INTERVAL_MS,
    cooldownMs: AUTO_ALERT_COOLDOWN_MS,
    running: !!autoAlertState.running,
  });
});

app.post('/api/ml/train', async (_req, res) => {
  try {
    const script = path.join(__dirname, 'ml', 'train.py');
    const result = await runPythonJson(script, {}, 120000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/ml/flood/predict-realtime', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const model = String(req.query.model || '').trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ ok: false, error: 'lat and lng are required' });

    const state = String(req.query.state || '').trim();
    const district = String(req.query.district || '').trim();
    
    // Fetch weather and river data IN PARALLEL for speed
    const [wx, riverData] = await Promise.all([
      cachedJson(`flood:wx:${lat.toFixed(3)}:${lng.toFixed(3)}`, 2 * 60 * 1000, () => getWeatherNow(lat, lng)),
      getRiverData(lat, lng, state, district)
    ]);
    
    let riverLevelM = 0;
    let riverSource = 'none';
    
    if (riverData.ok) {
      riverLevelM = riverData.riverLevelM;
      riverSource = riverData.source;
    } else {
      // Fallback to rainfall-based estimation if no river data available
      riverLevelM = estimateRiverLevelM({ precipitationMm: wx?.precipitationMm });
      riverSource = 'rainfall-estimate';
    }
    
    const features = floodFeaturesFromWeather(wx, { state: state || 'Unknown', district: district || 'Unknown', river_level_m: riverLevelM });
    
    // Use JS-only prediction (skip Python for speed)
    const rainfall = Number(features?.rainfall_mm) || 0;
    const river = Number(features?.river_level_m) || 0;
    
    let severity = 'low';
    let riskLevel = 0;
    
    if (rainfall >= 50 || river >= 5) {
      severity = 'severe';
      riskLevel = 2;
    } else if (rainfall >= 20 || river >= 3) {
      severity = 'moderate';
      riskLevel = 1;
    } else {
      severity = 'low';
      riskLevel = 0;
    }
    
    const out = {
      flood_severity: severity,
      flood_risk_level: riskLevel,
      model: 'js-fast',
      note: 'Fast rule-based prediction'
    };

    res.json({
      ok: true,
      lat,
      lng,
      weather: { source: wx?.source || null, time: wx?.time || null, precipitationMm: wx?.precipitationMm ?? null, windGust: wx?.windGust ?? null, pressureHpa: wx?.pressureHpa ?? null, temperatureC: wx?.temperatureC ?? null },
      river: {
        source: riverSource,
        levelM: riverLevelM,
        dischargeM3s: riverData?.dischargeM3s || null,
        method: riverData?.method || 'rainfall-estimate',
        time: riverData?.time || new Date().toISOString(),
      },
      features,
      ...out,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/ml/flood/train', async (_req, res) => {
  try {
    const script = path.join(__dirname, 'ml', 'flood_train.py');
    const result = await runPythonJson(script, {}, 180000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/ml/flood/predict', async (req, res) => {
  try {
    const body = req.body || {};
    const model = String(body?.model || '').trim();
    const features = body?.features || {};
    if (!features || typeof features !== 'object') return res.status(400).json({ ok: false, error: 'features object is required' });

    try {
      const modelsDir = path.join(__dirname, 'data', 'models');
      const modelPath = model ? path.join(modelsDir, `flood_${model}.joblib`) : path.join(modelsDir, 'india_flood_active.joblib');
      if (!fs.existsSync(modelPath)) {
        return res.status(503).json({
          ok: false,
          error: model
            ? `Flood model not trained: ${path.basename(modelPath)} is missing. Train first (python .\\ml\\flood_train.py) or remove model parameter.`
            : 'Flood model not trained: india_flood_active.joblib is missing. Train first: python .\\ml\\flood_train.py',
        });
      }
    } catch {
      // ignore
    }

    const script = path.join(__dirname, 'ml', 'flood_predict.py');
    const out = await runPythonJson(script, { model: model || undefined, features }, 12000);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/ml/predict', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const model = String(req.query.model || '').trim();
    const radiusKm = Number(req.query.radiusKm || 300);
    const minutes = Number(req.query.minutes || 24 * 60);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ ok: false, error: 'lat and lng are required' });

    const [wx, eq] = await Promise.all([
      cachedJson(`ml:wx:${lat.toFixed(3)}:${lng.toFixed(3)}`, 2 * 60 * 1000, () => getWeatherNow(lat, lng)),
      cachedJson(`ml:eq:${lat.toFixed(3)}:${lng.toFixed(3)}:${radiusKm}:${minutes}`, 30 * 1000, async () => {
        const start = new Date(Date.now() - minutes * 60 * 1000).toISOString();
        const url =
          'https://earthquake.usgs.gov/fdsnws/event/1/query' +
          `?format=geojson&latitude=${encodeURIComponent(lat)}` +
          `&longitude=${encodeURIComponent(lng)}` +
          `&maxradiuskm=${encodeURIComponent(radiusKm)}` +
          `&starttime=${encodeURIComponent(start)}` +
          '&orderby=time&limit=50';
        return httpsGetJson(url);
      }),
    ]);

    const precipitation = Number(wx?.precipitationMm);
    const gust = Number(wx?.windGust);
    const pressure = Number(wx?.pressureHpa);
    const temp = Number(wx?.temperatureC);

    const features = Array.isArray(eq?.features) ? eq.features : [];
    const mags = features.map(f => Number(f?.properties?.mag)).filter(n => Number.isFinite(n));
    const maxMag = mags.length ? Math.max(...mags) : 0;

    const script = path.join(__dirname, 'ml', 'predict.py');
    const payload = {
      model: model || undefined,
      features: {
        precipitation_mm: Number.isFinite(precipitation) ? precipitation : null,
        wind_gust: Number.isFinite(gust) ? gust : null,
        pressure_hpa: Number.isFinite(pressure) ? pressure : null,
        temp_c: Number.isFinite(temp) ? temp : null,
        max_mag: Number.isFinite(maxMag) ? maxMag : null,
      }
    };

    // Try Python ML first, fallback to JS-only prediction if Python not available
    let pred;
    try {
      pred = await runPythonJson(script, payload, 12000);
    } catch (pyErr) {
      console.log('[ML] Python ML unavailable, using JS fallback:', pyErr?.message || pyErr);
      // JS-only fallback: simple rule-based risk prediction
      let riskLevel = 0;
      let riskLabel = 'low';
      
      if (Number.isFinite(maxMag) && maxMag >= 5.5) {
        riskLevel = 2;
        riskLabel = 'high';
      } else if (Number.isFinite(precipitation) && precipitation >= 20) {
        riskLevel = 2;
        riskLabel = 'high';
      } else if (Number.isFinite(maxMag) && maxMag >= 4.5) {
        riskLevel = 1;
        riskLabel = 'medium';
      } else if (Number.isFinite(precipitation) && precipitation >= 8) {
        riskLevel = 1;
        riskLabel = 'medium';
      }
      
      pred = {
        model: 'js-fallback (no-python)',
        risk_label: riskLabel,
        risk_level: riskLevel,
        probabilities: null,
        note: 'Python ML unavailable - using rule-based JS prediction'
      };
    }

    res.json({
      ok: true,
      lat,
      lng,
      model: pred?.model || (model || 'active'),
      riskLabel: pred?.risk_label || null,
      riskLevel: pred?.risk_level ?? null,
      probabilities: pred?.probabilities || null,
      features: payload.features,
      weatherTime: String(wx?.time || ''),
      earthquakes: { radiusKm, minutes, maxMagnitude: maxMag, count: features.length },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/realtime/earthquakes', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusKm = Number(req.query.radiusKm || 500);
    const minutes = Number(req.query.minutes || 60 * 24);
    const limit = Number(req.query.limit || 50);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ ok: false, error: 'lat and lng are required' });
    if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 2000) return res.status(400).json({ ok: false, error: 'radiusKm must be 1..2000' });
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 14) return res.status(400).json({ ok: false, error: 'minutes must be 1..20160' });

    const start = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const url =
      'https://earthquake.usgs.gov/fdsnws/event/1/query' +
      `?format=geojson&latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lng)}` +
      `&maxradiuskm=${encodeURIComponent(radiusKm)}` +
      `&starttime=${encodeURIComponent(start)}` +
      `&orderby=time&limit=${encodeURIComponent(limit)}`;

    const key = `usgs:${lat.toFixed(3)}:${lng.toFixed(3)}:${radiusKm}:${minutes}:${limit}`;
    const data = await cachedJson(key, 30 * 1000, () => httpsGetJson(url));

    const features = Array.isArray(data?.features) ? data.features : [];
    const quakes = features
      .map((f) => {
        const mag = Number(f?.properties?.mag);
        const place = String(f?.properties?.place || '');
        const timeMs = Number(f?.properties?.time);
        const coords = Array.isArray(f?.geometry?.coordinates) ? f.geometry.coordinates : [];
        const qLng = Number(coords[0]);
        const qLat = Number(coords[1]);
        const depthKm = Number(coords[2]);
        return {
          id: String(f?.id || ''),
          magnitude: Number.isFinite(mag) ? mag : null,
          place,
          time: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null,
          lat: Number.isFinite(qLat) ? qLat : null,
          lng: Number.isFinite(qLng) ? qLng : null,
          depthKm: Number.isFinite(depthKm) ? depthKm : null,
          url: String(f?.properties?.url || ''),
        };
      })
      .filter((q) => q.id && Number.isFinite(q.lat) && Number.isFinite(q.lng));

    const maxMag = quakes.reduce((m, q) => (Number.isFinite(q.magnitude) ? Math.max(m, q.magnitude) : m), -Infinity);
    res.json({ ok: true, source: 'usgs', query: { lat, lng, radiusKm, minutes }, maxMagnitude: Number.isFinite(maxMag) ? maxMag : null, quakes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/realtime/weather', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ ok: false, error: 'lat and lng are required' });

    const wx = await getWeatherNow(lat, lng);
    res.json({
      ok: true,
      source: wx.source,
      lat,
      lng,
      time: wx.time,
      temperatureC: wx.temperatureC,
      pressureHpa: wx.pressureHpa,
      precipitationMm: wx.precipitationMm,
      windGust: wx.windGust,
      locationName: wx.locationName || undefined,
      region: wx.region || undefined,
      country: wx.country || undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/realtime/risk', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusKm = Number(req.query.radiusKm || 300);
    const minutes = Number(req.query.minutes || 24 * 60);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ ok: false, error: 'lat and lng are required' });

    const [wx, eq] = await Promise.all([
      cachedJson(`risk:wx:${lat.toFixed(3)}:${lng.toFixed(3)}`, 2 * 60 * 1000, () => getWeatherNow(lat, lng)),
      cachedJson(`risk:eq:${lat.toFixed(3)}:${lng.toFixed(3)}:${radiusKm}:${minutes}`, 30 * 1000, async () => {
        const start = new Date(Date.now() - minutes * 60 * 1000).toISOString();
        const url =
          'https://earthquake.usgs.gov/fdsnws/event/1/query' +
          `?format=geojson&latitude=${encodeURIComponent(lat)}` +
          `&longitude=${encodeURIComponent(lng)}` +
          `&maxradiuskm=${encodeURIComponent(radiusKm)}` +
          `&starttime=${encodeURIComponent(start)}` +
          '&orderby=time&limit=50';
        return httpsGetJson(url);
      }),
    ]);

    const precipitation = Number(wx?.precipitationMm);
    const windGust = Number(wx?.windGust);

    const features = Array.isArray(eq?.features) ? eq.features : [];
    const mags = features.map(f => Number(f?.properties?.mag)).filter(n => Number.isFinite(n));
    const maxMag = mags.length ? Math.max(...mags) : null;

    // Baseline risk rules (ML will be added next)
    let level = 'low';
    const reasons = [];

    if (Number.isFinite(maxMag) && maxMag >= 5.5) {
      level = 'high';
      reasons.push(`Earthquake magnitude ${maxMag.toFixed(1)} detected nearby`);
    } else if (Number.isFinite(maxMag) && maxMag >= 4.5) {
      level = level === 'high' ? level : 'medium';
      reasons.push(`Earthquake magnitude ${maxMag.toFixed(1)} detected nearby`);
    }

    if (Number.isFinite(precipitation) && precipitation >= 20) {
      level = 'high';
      reasons.push(`Heavy precipitation ${precipitation} mm detected`);
    } else if (Number.isFinite(precipitation) && precipitation >= 8) {
      level = level === 'high' ? level : 'medium';
      reasons.push(`Moderate precipitation ${precipitation} mm detected`);
    }

    if (Number.isFinite(windGust) && windGust >= 60) {
      level = 'high';
      reasons.push(`Very strong wind gusts ${windGust} detected`);
    } else if (Number.isFinite(windGust) && windGust >= 40) {
      level = level === 'high' ? level : 'medium';
      reasons.push(`Strong wind gusts ${windGust} detected`);
    }

    res.json({
      ok: true,
      lat,
      lng,
      riskLevel: level,
      reasons,
      seaLevel: { ok: false, note: 'Sea-level real-time requires a provider/API key. Currently disabled (no-keys mode).' },
      weather: {
        source: 'open-meteo',
        time: String(wx?.time || ''),
        precipitationMm: Number.isFinite(precipitation) ? precipitation : null,
        windGusts10m: Number.isFinite(windGust) ? windGust : null,
        pressureMslHpa: Number.isFinite(Number(wx?.pressureHpa)) ? Number(wx.pressureHpa) : null,
        temperatureC: Number.isFinite(Number(wx?.temperatureC)) ? Number(wx.temperatureC) : null,
      },
      earthquakes: {
        source: 'usgs',
        radiusKm,
        minutes,
        maxMagnitude: Number.isFinite(maxMag) ? maxMag : null,
        count: features.length,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin realtime stream (SSE)
app.get('/api/admin/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Initial snapshot
  res.write(`event: users\ndata: ${JSON.stringify(readUsersDb())}\n\n`);
  res.write(`event: alerts\ndata: ${JSON.stringify(activeAlertsNow())}\n\n`);
  const keepAlive = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {}\n\n`);
    } catch {
      // ignore
    }
  }, 25000);

  sseClients.add(res);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// Admin API: list users
app.get('/api/admin/users', (_req, res) => {
  res.json({ ok: true, users: readUsersDb() });
});

// Public API: called after OTP verify to save the user record (demo)
app.post('/api/users/upsert', (req, res) => {
  try {
    const u = req.body || {};
    const name = String(u?.name || '').trim();
    const email = String(u?.email || '').trim().toLowerCase();
    const phone = String(u?.phone || '').trim();

    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'valid email is required' });
    if (!/^[0-9]{10}$/.test(phone)) return res.status(400).json({ ok: false, error: 'valid 10-digit phone is required' });

    const nowIso = new Date().toISOString();
    const record = {
      id: String(u?.id || `U-${phone}`),
      name,
      phone,
      email,
      state: String(u?.state || ''),
      district: String(u?.district || ''),
      location: String(u?.location || '').trim() || `${String(u?.district || '').trim()}${u?.state ? ', ' + String(u.state).trim() : ''}`.trim(),
      registeredAt: String(u?.registeredAt || nowIso),
      status: String(u?.status || 'active'),
      lat: typeof u?.lat === 'number' ? u.lat : (u?.lat ? Number(u.lat) : undefined),
      lng: typeof u?.lng === 'number' ? u.lng : (u?.lng ? Number(u.lng) : undefined)
    };

    const users = upsertUser(record);
    sseSend('users', users);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed to upsert user' });
  }
});

// Admin API: toggle status
app.patch('/api/admin/users/:id/status', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
    if (status !== 'active' && status !== 'inactive') {
      return res.status(400).json({ ok: false, error: 'status must be active|inactive' });
    }

    const users = readUsersDb();
    const idx = users.findIndex(u => String(u?.id) === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'user not found' });
    users[idx] = { ...users[idx], status };
    writeUsersDb(users);
    sseSend('users', users);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed to update status' });
  }
});

// Diagnostics: verifies SMTP credentials without sending mail
app.get('/api/mail/test', async (_req, res) => {
  try {
    const tx = transporter();
    await tx.verify();
    return res.json({ ok: true, message: 'SMTP verified' });
  } catch (e) {
    console.error('MAIL_VERIFY_ERROR:', e);
    const msg = String(e?.message || 'SMTP verify failed');
    const hint = msg.includes('535-5.7.8')
      ? 'BadCredentials: Enable 2-Step Verification, generate a NEW App Password, and ensure it belongs to the same Gmail account.'
      : undefined;
    return res.status(500).json({ ok: false, error: msg, hint });
  }
});

app.post('/api/auth/request-otp', otpLimiter, async (req, res) => {
  try {
    const { email, phone, name } = req.body || {};

    const safeEmail = String(email || '').trim().toLowerCase();
    const safePhone = String(phone || '').trim();

    if (!safeEmail || !safeEmail.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }
    if (!/^[0-9]{10}$/.test(safePhone)) {
      return res.status(400).json({ ok: false, error: 'Valid 10-digit phone is required' });
    }

    const otp = makeOtp();
    const key = otpKey(safeEmail, safePhone);
    otpStore.set(key, {
      otpHash: sha256(otp),
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
    });

    await sendOtpEmail({ to: safeEmail, name, phone: safePhone, otp });

    return res.json({ ok: true, expiresInSec: Math.floor(OTP_TTL_MS / 1000) });
  } catch (e) {
    console.error('OTP_SEND_ERROR:', e);
    const msg = String(e?.message || 'Failed to send OTP');
    const hint = msg.includes('535-5.7.8')
      ? 'Gmail rejected login. Ensure 2-Step Verification is ON and use a NEW Gmail App Password (not your Gmail password).'
      : undefined;

    if (allowDevOtp()) {
      const { email, phone, name } = req.body || {};
      const safeEmail = String(email || '').trim().toLowerCase();
      const safePhone = String(phone || '').trim();

      if (safeEmail && safeEmail.includes('@') && /^[0-9]{10}$/.test(safePhone)) {
        const otp = makeOtp();
        const key = otpKey(safeEmail, safePhone);
        otpStore.set(key, {
          otpHash: sha256(otp),
          expiresAt: Date.now() + OTP_TTL_MS,
          attempts: 0,
        });

        return res.json({
          ok: true,
          expiresInSec: Math.floor(OTP_TTL_MS / 1000),
          devOtp: otp,
          warning: 'SMTP failed; returned devOtp because ALLOW_DEV_OTP is enabled.',
        });
      }
    }

    return res.status(500).json({ ok: false, error: msg, hint });
  }
});

app.post('/api/auth/verify-otp', otpLimiter, (req, res) => {
  const { email, phone, otp } = req.body || {};

  const safeEmail = String(email || '').trim().toLowerCase();
  const safePhone = String(phone || '').trim();
  const safeOtp = String(otp || '').trim();

  if (!safeEmail || !safeEmail.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }
  if (!/^[0-9]{10}$/.test(safePhone)) {
    return res.status(400).json({ ok: false, error: 'Valid 10-digit phone is required' });
  }
  if (!/^[0-9]{6}$/.test(safeOtp)) {
    return res.status(400).json({ ok: false, error: 'Valid 6-digit OTP is required' });
  }

  const key = otpKey(safeEmail, safePhone);
  const rec = otpStore.get(key);
  if (!rec) return res.status(400).json({ ok: false, error: 'OTP not found. Please resend.' });

  if (Date.now() > rec.expiresAt) {
    otpStore.delete(key);
    return res.status(400).json({ ok: false, error: 'OTP expired. Please resend.' });
  }

  rec.attempts += 1;
  if (rec.attempts > 5) {
    otpStore.delete(key);
    return res.status(429).json({ ok: false, error: 'Too many attempts. Please request a new OTP.' });
  }

  if (sha256(safeOtp) !== rec.otpHash) {
    return res.status(400).json({ ok: false, error: 'Invalid OTP' });
  }

  otpStore.delete(key);
  return res.json({ ok: true });
});

// After OTP verification (registration or login), set a 4-digit PIN for the user
app.post('/api/auth/set-pin', otpLimiter, (req, res) => {
  try {
    const { email, phone, pin } = req.body || {};
    const safeEmail = String(email || '').trim().toLowerCase();
    const safePhone = String(phone || '').trim();
    const safePin = String(pin || '').trim();

    if (!safeEmail || !safeEmail.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }
    if (!/^[0-9]{10}$/.test(safePhone)) {
      return res.status(400).json({ ok: false, error: 'Valid 10-digit phone is required' });
    }
    if (!/^[0-9]{4}$/.test(safePin)) {
      return res.status(400).json({ ok: false, error: 'Valid 4-digit PIN is required' });
    }

    const users = readUsersDb();
    const idx = users.findIndex(u => String(u?.phone || '').trim() === safePhone || String(u?.email || '').trim().toLowerCase() === safeEmail);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'User not found. Please register first.' });

    if (String(users[idx]?.status || 'active') !== 'active') {
      return res.status(403).json({ ok: false, error: 'Account is inactive. Contact admin.' });
    }

    const pinSalt = makeSalt();
    const pinHash = hashPin(safePin, pinSalt);
    users[idx] = { ...users[idx], pinSalt, pinHash };
    writeUsersDb(users);
    sseSend('users', users);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to set PIN' });
  }
});

// Existing user login via PIN
app.post('/api/auth/login-pin', otpLimiter, (req, res) => {
  try {
    const { email, phone, pin } = req.body || {};
    const safeEmail = String(email || '').trim().toLowerCase();
    const safePhone = String(phone || '').trim();
    const safePin = String(pin || '').trim();

    if (!safeEmail && !safePhone) return res.status(400).json({ ok: false, error: 'email or phone is required' });
    if (safePhone && !/^[0-9]{10}$/.test(safePhone)) {
      return res.status(400).json({ ok: false, error: 'Valid 10-digit phone is required' });
    }
    if (safeEmail && !safeEmail.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }
    if (!/^[0-9]{4}$/.test(safePin)) {
      return res.status(400).json({ ok: false, error: 'Valid 4-digit PIN is required' });
    }

    const users = readUsersDb();
    const u = users.find(x => (safePhone && String(x?.phone || '').trim() === safePhone) || (safeEmail && String(x?.email || '').trim().toLowerCase() === safeEmail));
    if (!u) return res.status(404).json({ ok: false, error: 'User not found. Please register.' });
    if (String(u?.status || 'active') !== 'active') return res.status(403).json({ ok: false, error: 'Account is inactive. Contact admin.' });
    if (!u.pinSalt || !u.pinHash) return res.status(400).json({ ok: false, error: 'PIN not set for this account. Use OTP login and set PIN.' });

    const ok = hashPin(safePin, u.pinSalt) === u.pinHash;
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid PIN' });

    const safeUser = { ...u };
    delete safeUser.pinSalt;
    delete safeUser.pinHash;
    return res.json({ ok: true, user: safeUser });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Login failed' });
  }
});

// Existing user login after OTP verification
app.post('/api/auth/login-otp', otpLimiter, (req, res) => {
  try {
    const { email, phone } = req.body || {};
    const safeEmail = String(email || '').trim().toLowerCase();
    const safePhone = String(phone || '').trim();
    if (!safeEmail && !safePhone) return res.status(400).json({ ok: false, error: 'email or phone is required' });

    const users = readUsersDb();
    const u = users.find(x => (safePhone && String(x?.phone || '').trim() === safePhone) || (safeEmail && String(x?.email || '').trim().toLowerCase() === safeEmail));
    if (!u) return res.status(404).json({ ok: false, error: 'User not found. Please register.' });
    if (String(u?.status || 'active') !== 'active') return res.status(403).json({ ok: false, error: 'Account is inactive. Contact admin.' });

    const safeUser = { ...u };
    delete safeUser.pinSalt;
    delete safeUser.pinHash;
    return res.json({ ok: true, user: safeUser });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Login failed' });
  }
});

// Admin broadcast (email only in backend). SMS can be added later with provider API.
app.post('/api/admin/broadcast-alert', mailLimiter, async (req, res) => {
  try {
    const { alert, recipients } = req.body || {};

    if (!alert || typeof alert !== 'object') {
      return res.status(400).json({ ok: false, error: 'alert payload is required' });
    }

    const list = Array.isArray(recipients) ? recipients : [];
    const emails = list
      .map(r => String(r?.email || '').trim().toLowerCase())
      .filter(e => e && e.includes('@'));

    if (!emails.length) {
      return res.status(400).json({ ok: false, error: 'No valid recipients' });
    }

    const subject = `⚠️ NDMS SIMULATED ALERT: ${(alert.type || 'Alert').toUpperCase()} (${String(alert.severity || '').toUpperCase()})`;
    const text =
      `⚠️ SIMULATED DISASTER ALERT (Training/Test)\n\n` +
      `Type: ${alert.type || '—'}\n` +
      `Severity: ${alert.severity || '—'}\n` +
      `Location: ${alert.location || '—'}\n` +
      `Radius: ${alert.radius || '—'} km\n` +
      `Message: ${alert.message || ''}\n\n` +
      `Follow official guidance.\n` +
      `\n— NDMS (Simulation)\n`;

    // Send sequentially to avoid Gmail throttling in demos
    for (const to of emails) {
      await sendAlertEmail({ to, subject, text });
    }

    return res.json({ ok: true, sent: emails.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to send alert emails' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AGENTIC AI & BLOCKCHAIN API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Agentic AI - Monitor Agent Status
 * Returns real-time status of autonomous monitoring
 */
app.get('/api/agent/status', (req, res) => {
  try {
    const status = monitorAgent.getStatus();
    const decisions = decisionEngine.getRecentDecisions(5);
    const stats = decisionEngine.getStats();
    
    res.json({
      ok: true,
      agent: 'MonitorAgent',
      status: status,
      recentDecisions: decisions,
      stats: stats,
      technology: 'Agentic AI - Autonomous Disaster Monitoring'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Start/Stop Agentic AI Monitoring
 */
app.post('/api/agent/control', (req, res) => {
  try {
    const { action } = req.body;
    
    if (action === 'start') {
      monitorAgent.start();
      res.json({ ok: true, message: 'Agentic AI monitoring started', running: true });
    } else if (action === 'stop') {
      monitorAgent.stop();
      res.json({ ok: true, message: 'Agentic AI monitoring stopped', running: false });
    } else {
      res.status(400).json({ ok: false, error: 'Invalid action. Use start or stop' });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Blockchain - Get Alert Audit Trail
 * Returns all alerts with blockchain verification
 */
app.get('/api/blockchain/alerts', (req, res) => {
  try {
    const alerts = blockchainAudit.getAllAlerts();
    const stats = blockchainAudit.getStats();
    
    res.json({
      ok: true,
      technology: 'Blockchain - Immutable Alert Audit Trail',
      alerts: alerts,
      stats: stats,
      chainValid: stats.chainValid,
      totalBlocks: stats.totalBlocks
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Blockchain - Verify Specific Alert
 */
app.get('/api/blockchain/verify/:txHash', (req, res) => {
  try {
    const { txHash } = req.params;
    const alert = blockchainAudit.getAlertByHash(txHash);
    
    if (!alert) {
      return res.status(404).json({ ok: false, error: 'Alert not found' });
    }
    
    const verification = blockchainAudit.verifyBlock(alert.index);
    
    res.json({
      ok: true,
      verified: verification.valid,
      alert: alert,
      message: verification.message
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Blockchain - Create Alert with Audit Trail
 * Admin endpoint with blockchain logging
 */
app.post('/api/admin/alert-with-audit', async (req, res) => {
  try {
    const { type, severity, location, message, adminWallet } = req.body;
    
    if (!type || !message) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: type, message' });
    }
    
    // Create alert
    const alert = {
      type,
      severity: severity || 'low',
      location: location || 'Unknown',
      message,
      adminId: adminWallet || 'admin-1',
      timestamp: new Date().toISOString()
    };
    
    // Log to blockchain
    const block = blockchainAudit.addAlert(alert, adminWallet);
    
    // Also save to regular alerts for display
    const alerts = readAlertsDb();
    alerts.push({
      id: block.alert.id,
      ...alert,
      blockchainHash: block.hash,
      transactionHash: block.transactionHash
    });
    writeAlertsDb(alerts);
    
    res.json({
      ok: true,
      message: 'Alert created and logged to blockchain',
      alert: block.alert,
      blockchain: {
        blockIndex: block.index,
        hash: block.hash,
        transactionHash: block.transactionHash
      },
      technology: 'Blockchain-verified Alert'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Blockchain - Get Chain Statistics
 */
app.get('/api/blockchain/stats', (req, res) => {
  try {
    const stats = blockchainAudit.getStats();
    const chainValid = blockchainAudit.verifyChain();
    
    res.json({
      ok: true,
      technology: 'Blockchain Audit System',
      stats: {
        ...stats,
        integrityVerified: chainValid.valid,
        totalBlocks: stats.totalBlocks,
        alertsOnChain: stats.totalAlerts
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Serve the static website
app.use(express.static(PUBLIC_DIR));

// Make /admin9392 resolve even if user types /admin9392 (without trailing slash)
app.get('/admin9392', (_req, res) => {
  res.redirect('/admin9392/');
});

// Common mistake: user types /admin9392.html
app.get(['/admin9392.html', '/admin9392.html/'], (_req, res) => {
  res.redirect('/admin9392/');
});

app.listen(PORT, () => {
  try {
    const pass = normalizeEnvSecret(process.env.GMAIL_APP_PASSWORD);
    if (pass && pass.length !== 16) {
      console.warn(
        `Warning: GMAIL_APP_PASSWORD length is ${pass.length}. Gmail App Passwords are typically 16 characters (spaces optional).`
      );
    }
  } catch (_e) {
    // ignore
  }
  console.log(`NDMS server running: http://localhost:${PORT}`);

  // Auto-alert worker (real-mode demo): continuously monitor conditions and send alerts automatically.
  try {
    if (autoAlertState.enabled) {
      setTimeout(() => {
        runAutoAlertCycle().catch(() => {
          // ignore
        });
      }, 1500);

      setInterval(() => {
        runAutoAlertCycle().catch(() => {
          // ignore
        });
      }, Math.max(15000, AUTO_ALERT_INTERVAL_MS));

      console.log(`Auto-alert monitoring enabled (interval=${AUTO_ALERT_INTERVAL_MS}ms, cooldown=${AUTO_ALERT_COOLDOWN_MS}ms)`);
    } else {
      console.log('Auto-alert monitoring disabled (AUTO_ALERTS_ENABLED=false)');
    }
  } catch {
    // ignore
  }
});
