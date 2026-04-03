import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier

ROOT = Path(__file__).resolve().parents[1]
DATASETS_DIR = ROOT / 'data' / 'datasets'
MODELS_DIR = ROOT / 'data' / 'models'
TRAIN_CSV = DATASETS_DIR / 'india_flood_dataset_ml_ready.csv'

TARGET = 'flood_severity'

NUMERIC = ['rainfall_mm', 'river_level_m', 'month', 'dayofweek']
CATEGORICAL = ['state', 'district']


def train() -> dict:
    if not TRAIN_CSV.exists():
        raise FileNotFoundError(f'Missing dataset: {TRAIN_CSV}')

    df = pd.read_csv(TRAIN_CSV)
    for col in ['date', 'state', 'district', 'rainfall_mm', 'river_level_m', TARGET]:
        if col not in df.columns:
            raise ValueError(f'Missing column: {col}')

    dts = pd.to_datetime(df['date'], errors='coerce', utc=False)
    df = df.copy()
    df['month'] = dts.dt.month.fillna(1).astype(int)
    df['dayofweek'] = dts.dt.dayofweek.fillna(0).astype(int)

    X = df[NUMERIC + CATEGORICAL].copy()
    y = df[TARGET].astype(str).str.strip().str.title()

    # Basic cleanup
    X['rainfall_mm'] = pd.to_numeric(X['rainfall_mm'], errors='coerce').fillna(0.0)
    X['river_level_m'] = pd.to_numeric(X['river_level_m'], errors='coerce').fillna(0.0)
    X['month'] = pd.to_numeric(X['month'], errors='coerce').fillna(1).astype(int)
    X['dayofweek'] = pd.to_numeric(X['dayofweek'], errors='coerce').fillna(0).astype(int)
    X['state'] = X['state'].astype(str).fillna('Unknown')
    X['district'] = X['district'].astype(str).fillna('Unknown')

    try:
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42, stratify=y
        )
    except Exception:
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42
        )

    pre = ColumnTransformer(
        transformers=[
            ('num', StandardScaler(), NUMERIC),
            ('cat', OneHotEncoder(handle_unknown='ignore'), CATEGORICAL),
        ],
        remainder='drop'
    )

    models = {
        'decision_tree': DecisionTreeClassifier(max_depth=6, random_state=42),
        'random_forest': RandomForestClassifier(n_estimators=300, random_state=42, n_jobs=-1),
        'logistic_regression': LogisticRegression(max_iter=2000),
        'svm': SVC(kernel='rbf', probability=True, random_state=42),
    }

    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    report = {}
    best_name = None
    best_acc = -1.0

    for name, clf in models.items():
        pipe = Pipeline([
            ('pre', pre),
            ('clf', clf),
        ])
        pipe.fit(X_train, y_train)
        pred = pipe.predict(X_test)
        acc = float(accuracy_score(y_test, pred))
        report[name] = {'accuracy': acc}

        out_path = MODELS_DIR / f'flood_{name}.joblib'
        joblib.dump({'pipeline': pipe, 'numeric': NUMERIC, 'categorical': CATEGORICAL, 'target': TARGET}, out_path)

        if acc > best_acc:
            best_acc = acc
            best_name = name

    if not best_name:
        raise RuntimeError('No model was trained successfully')

    active_src = MODELS_DIR / f'flood_{best_name}.joblib'
    active_path = MODELS_DIR / 'india_flood_active.joblib'
    joblib.dump(joblib.load(active_src), active_path)

    return {
        'ok': True,
        'train_csv': str(TRAIN_CSV),
        'models_dir': str(MODELS_DIR),
        'best_model': best_name,
        'metrics': report,
        'numeric': NUMERIC,
        'categorical': CATEGORICAL,
    }


if __name__ == '__main__':
    try:
        result = train()
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        raise
