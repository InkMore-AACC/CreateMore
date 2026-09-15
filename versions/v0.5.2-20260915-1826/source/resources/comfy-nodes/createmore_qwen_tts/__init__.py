"""Qwen TTS nodes. Inference dependencies stay in this node's subprocess."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

import numpy as np
import torch
import folder_paths
import comfy.model_management as mm

ROOT = Path(__file__).resolve().parent

def model_choices():
    found = {}
    for key in ('TTS', 'tts'):
        if key not in folder_paths.folder_names_and_paths:
            continue
        for folder in folder_paths.get_folder_paths(key):
            base = Path(folder)
            for config in base.glob('**/config.json'):
                if 'Qwen3-TTS-12Hz-' in str(config.parent) and (config.parent / 'model.safetensors').is_file() and config.parent.name != 'speech_tokenizer':
                    found[str(config.parent.relative_to(base))] = config.parent
    return found

class CreateMoreQwenTTS:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {
            'model': (sorted(model_choices()) or ['No local Qwen3 TTS model'],),
            'mode': (['voice_design', 'custom_voice', 'voice_clone'],),
            'text': ('STRING', {'multiline': True, 'default': '你好，欢迎来到我们的创作画布。'}),
            'instruction': ('STRING', {'multiline': True, 'default': '温暖自然，略带笑意，不要播音腔。'}),
            'speaker': (['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee'],),
            'language': (['Chinese', 'Auto', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'],),
            'seed': ('INT', {'default': 42, 'min': 0, 'max': 2147483647, 'control_after_generate': True}),
            'max_new_tokens': ('INT', {'default': 2048, 'min': 32, 'max': 4096}),
            'reference_text': ('STRING', {'multiline': True, 'default': ''}),
        }, 'optional': {'reference_audio': ('AUDIO',)}}

    RETURN_TYPES = ('AUDIO',)
    FUNCTION = 'generate'
    CATEGORY = 'CreateMore/Audio'

    def generate(self, model, mode, text, instruction, speaker, language, seed, max_new_tokens, reference_text, reference_audio=None):
        models = model_choices()
        if model not in models:
            raise ValueError('Local Qwen3 TTS model not found; no automatic model download.')
        expected = {'voice_design': 'VoiceDesign', 'custom_voice': 'CustomVoice', 'voice_clone': 'Base'}[mode]
        if expected not in str(models[model]):
            raise ValueError('Selected model does not support ' + mode)
        if not text.strip() or len(text) > 4000:
            raise ValueError('Speech text must contain 1–4000 characters.')
        if mode == 'voice_clone' and reference_audio is None:
            raise ValueError('Voice cloning requires reference audio.')
        if mode == 'voice_clone' and instruction.strip():
            raise ValueError('Base voice cloning has no independent instruction control; clear instruction. It follows the reference delivery.')
        python = ROOT / 'runtime' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        if not python.is_file():
            raise RuntimeError('The isolated Qwen TTS runtime is not configured.')
        # Release Comfy's cached GPU models before the isolated speech worker starts.
        mm.unload_all_models()
        mm.soft_empty_cache()
        temporary_root = ROOT / 'runtime' / 'jobs'
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
            job = Path(directory)
            request = dict(model=str(models[model]), mode=mode, text=text, instruction=instruction, speaker=speaker, language=language, seed=seed, max_new_tokens=max_new_tokens, reference_text=reference_text)
            if reference_audio is not None:
                waveform = reference_audio['waveform'].detach().cpu().numpy()
                if waveform.ndim != 3 or waveform.shape[0] != 1:
                    raise ValueError('Use one reference audio clip.')
                sr = int(reference_audio['sample_rate'])
                if not 8000 <= sr <= 192000 or not 1 <= waveform.shape[-1] / sr <= 60:
                    raise ValueError('Reference audio must be between 1 and 60 seconds.')
                np.savez(job / 'reference.npz', waveform=waveform[0].mean(axis=0), sample_rate=sr)
            (job / 'request.json').write_text(json.dumps(request, ensure_ascii=False), encoding='utf-8')
            env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_HOME': str(ROOT / 'runtime' / 'hf'), 'NUMBA_CACHE_DIR': str(ROOT / 'runtime' / 'numba-cache')}
            with (job / 'worker.log').open('w', encoding='utf-8') as log:
                process = subprocess.Popen([str(python), str(ROOT / 'worker.py'), str(job)], env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                started = time.monotonic()
                try:
                    while process.poll() is None:
                        mm.throw_exception_if_processing_interrupted()
                        if time.monotonic() - started > 900:
                            raise TimeoutError('Qwen TTS exceeded 15 minutes; worker terminated.')
                        time.sleep(0.15)
                finally:
                    if process.poll() is None:
                        if os.name == 'nt':
                            # Windows venv launchers have a child interpreter.
                            subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW, timeout=10, check=False)
                        else:
                            process.kill()
                    process.wait()
            if process.returncode != 0:
                raise RuntimeError('Qwen TTS failed: ' + (job / 'worker.log').read_text(encoding='utf-8')[-5000:])
            with np.load(job / 'result.npz', allow_pickle=False) as result:
                samples = result['waveform'].copy()
                sr = int(result['sample_rate'])
            if not samples.size or not np.isfinite(samples).all():
                raise RuntimeError('Qwen TTS returned empty or invalid audio.')
            return ({'waveform': torch.from_numpy(samples).float().reshape(1, 1, -1), 'sample_rate': sr},)

from .camera import CreateMoreCameraPrompt

NODE_CLASS_MAPPINGS = {'CreateMoreQwenTTS': CreateMoreQwenTTS, 'CreateMoreCameraPrompt': CreateMoreCameraPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {'CreateMoreQwenTTS': 'Qwen3 TTS · 本地音色与情绪', 'CreateMoreCameraPrompt': '多角度 · 机位参数'}
