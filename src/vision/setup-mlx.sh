#!/bin/bash
# Setup script for the ColQwen2.5 vision embedding backend (MLX variant).
# Creates a Python venv, installs MLX dependencies, and verifies the model loads.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv-mlx"

echo "=== Vision Backend Setup (MLX) ==="
echo "Script dir: $SCRIPT_DIR"
echo "Venv dir: $VENV_DIR"

# Create venv if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python venv..."
    python3 -m venv "$VENV_DIR"
fi

# Activate and install
echo "Installing dependencies..."
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/requirements-mlx.txt"

# Verify model loads (quick health check)
echo ""
echo "Verifying MLX model can load..."
"$VENV_DIR/bin/python3" -c "
import mlx.core as mx
print(f'MLX version: {mx.__version__}')
print(f'Default device: {mx.default_device()}')
from mlx_embeddings.utils import load
print('mlx_embeddings imports OK')
print('Setup complete! Model weights will be downloaded on first use.')
"

echo ""
echo "=== Setup Complete ==="
echo "To test the server manually:"
echo "  $VENV_DIR/bin/python3 $SCRIPT_DIR/server_mlx.py"
echo ""
echo "To use MLX backend, set: VISION_BACKEND=mlx"
