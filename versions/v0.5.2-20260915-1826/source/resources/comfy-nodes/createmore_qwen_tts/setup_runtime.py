"""Run with the existing ComfyUI Python; never installs another ComfyUI."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import venv

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    comfy = root.parent.parent
    if root.parent.name != 'custom_nodes' or not (comfy / 'main.py').is_file():
        raise RuntimeError('Copy this node into the existing ComfyUI/custom_nodes first.')
    baseline = {name: importlib.metadata.version(name) for name in ('torch', 'transformers', 'accelerate')}
    runtime = root / 'runtime'
    python = runtime / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if args.install:
        if runtime.exists():
            raise RuntimeError('Runtime already exists and was preserved. Use --verify.')
        if shutil.disk_usage(root).free < 2_000_000_000:
            raise RuntimeError('Reserve at least 2 GB for node dependencies.')
        venv.EnvBuilder(with_pip=True, system_site_packages=True).create(runtime)
        purelib = subprocess.check_output([str(python), '-c', 'import sysconfig;print(sysconfig.get_paths()["purelib"])'], text=True).strip()
        Path(purelib, 'comfyui_existing.pth').write_text(sysconfig.get_paths()['purelib'] + '\n', encoding='utf-8')
        temporary = runtime / 'install-temp'
        temporary.mkdir()
        env = {**os.environ, 'TEMP': str(temporary), 'TMP': str(temporary), 'PIP_NO_CACHE_DIR': '1'}
        subprocess.run([str(python), '-m', 'pip', 'install', '--no-deps', 'qwen-tts==0.1.1'], check=True, env=env)
        subprocess.run([str(python), '-m', 'pip', 'install', 'transformers==4.57.3', 'accelerate==1.12.0', 'librosa==0.11.0', 'soundfile==0.13.1', 'sox==1.5.0'], check=True, env=env)
    if not python.exists():
        raise RuntimeError('No node runtime. Pass --install to install it explicitly.')
    subprocess.run([str(python), '-c', 'from qwen_tts import Qwen3TTSModel;import torch;print("QWEN_IMPORT_OK",torch.__version__)'], check=True)
    after = {name: importlib.metadata.version(name) for name in baseline}
    if after != baseline:
        raise RuntimeError('Unexpected main environment dependency change')
    print(json.dumps({'main_environment_unchanged': after, 'runtime': str(runtime)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
