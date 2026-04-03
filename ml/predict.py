import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / 'data'
MODELS_DIR = DATA_DIR / 'models'

FEATURES = [
    'precipitation_mm',
    'wind_gust',
    'pressure_hpa',
    'temp_c',
    'max_mag',
]


def _load_model(model_name: str | None):
    if model_name:
        path = MODELS_DIR / f'{model_name}.joblib'
    else:
        path = MODELS_DIR / 'active.joblib'
    if not path.exists():
        raise FileNotFoundError(f'Model not found: {path}')
    return joblib.load(path)


def predict(payload: dict) -> dict:
    model_name = str(payload.get('model') or '').strip() or None
    bundle = _load_model(model_name)
    pipe = bundle['pipeline']

    feats = payload.get('features') or {}
    row = []
    for k in FEATURES:
        v = feats.get(k)
        try:
            row.append(float(v))
        except Exception:
            row.append(float('nan'))

    X = pd.DataFrame([row], columns=FEATURES)

    if np.isnan(np.array(row, dtype=float)).any():
        raise ValueError('Missing/invalid feature values')

    pred = int(pipe.predict(X)[0])
    proba = None
    if hasattr(pipe, 'predict_proba'):
        p = pipe.predict_proba(X)[0]
        proba = [float(x) for x in p]

    risk_label = 'low' if pred == 0 else 'medium' if pred == 1 else 'high'

    return {
        'ok': True,
        'model': model_name or 'active',
        'risk_level': pred,
        'risk_label': risk_label,
        'probabilities': proba,
    }


if __name__ == '__main__':
    raw = ''
    try:
        raw = input()
    except EOFError:
        raw = ''

    if raw.strip():
        payload = json.loads(raw)
    else:
        payload = {}

    try:
        out = predict(payload)
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        raise
