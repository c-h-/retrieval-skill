#!/bin/bash
# Setup script for the ColQwen2.5 vision embedding backend.
# Creates a Python venv, installs dependencies, and verifies the model loads.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"

echo "=== Vision Backend Setup ==="
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
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"

# Verify model loads (quick health check)
echo ""
echo "Verifying model can load..."
"$VENV_DIR/bin/python3" -c "
import torch
print(f'PyTorch version: {torch.__version__}')
print(f'MPS available: {torch.backends.mps.is_available()}')
from colpali_engine.models import ColQwen2_5, ColQwen2_5_Processor
print('colpali_engine imports OK')
print('Setup complete! Model weights will be downloaded on first use.')
"

echo ""
echo "=== Setup Complete ==="
echo "To test the server manually:"
echo "  $VENV_DIR/bin/python3 $SCRIPT_DIR/server.py"
