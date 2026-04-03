import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = ROOT / 'data' / 'models'


def _load_model(model_name: str | None):
    if model_name:
        path = MODELS_DIR / f'flood_{model_name}.joblib'
    else:
        path = MODELS_DIR / 'india_flood_active.joblib'
    if not path.exists():
        if model_name:
            raise FileNotFoundError(f'Model not found: {path}. Train first or remove the model parameter to use the active model.')
        raise FileNotFoundError(
            f'Model not found: {path}. Train the India flood dataset model first: run "python .\\ml\\flood_train.py"'
        )
    return joblib.load(path)


def predict(payload: dict) -> dict:
    model_name = str(payload.get('model') or '').strip() or None
    bundle = _load_model(model_name)
    pipe = bundle['pipeline']
    numeric = list(bundle.get('numeric') or [])
    categorical = list(bundle.get('categorical') or [])
    features = numeric + categorical

    feats = payload.get('features') or {}
    row = []
    for k in features:
        v = feats.get(k)
        if k in numeric:
            try:
                row.append(float(v))
            except Exception:
                row.append(float('nan'))
        else:
            row.append('' if v is None else str(v))

    X = pd.DataFrame([row], columns=features)

    # validate numerics
    num_vals = np.array([row[i] for i, k in enumerate(features) if k in numeric], dtype=float)
    if np.isnan(num_vals).any():
        missing = [k for k in numeric if not isinstance(feats.get(k), (int, float, str)) or str(feats.get(k)).strip() == '' or str(feats.get(k)).lower() == 'nan']
        raise ValueError('Missing/invalid numeric feature values: ' + ', '.join(missing or numeric))

    pred = pipe.predict(X)[0]
    pred_label = str(pred)

    proba = None
    if hasattr(pipe, 'predict_proba'):
        try:
            p = pipe.predict_proba(X)[0]
            proba = [float(x) for x in p]
        except Exception:
            proba = None

    # map severity to risk label
    sev = pred_label.strip().lower()
    risk = 'low' if sev == 'low' else 'high' if sev in ('severe', 'high') else 'medium'

    return {
        'ok': True,
        'model': model_name or 'active',
        'flood_severity': pred_label,
        'risk_label': risk,
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
