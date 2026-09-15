"""Download selected pinned weights into an existing ComfyUI model store.

Dry-run by default. The manifest accounts for existing files and reserves 20 GB
of the user's 100 GB allowance for node dependencies and temporary files.
"""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path

def download(item, target):
    import requests
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + '.createmore-download')
    url = 'https://huggingface.co/' + item['repo'] + '/resolve/' + item['revision'] + '/' + item['source']
    for attempt in range(4):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset == item['size']:
            break
        if offset > item['size']:
            raise ValueError('Partial file larger than expected')
        try:
            with requests.get(url, headers={'Range': f'bytes={offset}-'}, stream=True, timeout=(20, 60)) as response:
                response.raise_for_status()
                if offset and (response.status_code != 206 or not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-')):
                    raise ValueError('Server did not honor resumption; preserved partial file')
                with partial.open('ab') as stream:
                    announced = offset // 500_000_000
                    for chunk in response.iter_content(1024 * 1024):
                        if offset + len(chunk) > item['size']:
                            raise ValueError('Download exceeded expected size')
                        stream.write(chunk)
                        offset += len(chunk)
                        if offset // 500_000_000 > announced:
                            announced = offset // 500_000_000
                            print(f'{target.name}: {offset / 1e9:.2f}/{item["size"] / 1e9:.2f} GB', flush=True)
            if offset != item['size']:
                raise requests.ConnectionError('Incomplete download')
            break
        except requests.RequestException:
            if attempt == 3:
                raise RuntimeError('Download failed after 4 attempts; partial data retained: ' + target.name) from None
            time.sleep(2)
    partial.rename(target)

PICKS = [
    ('Comfy-Org/Qwen-Image-Edit_ComfyUI', '984166f60a9b1fcede5e9b9287b7a7aebc050010', 'split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors', 'diffusion_models'),
    ('Comfy-Org/Qwen-Image_ComfyUI', '7beb7b647f04469fbe64ba8adc2bb0d7e5e9f73f', 'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors', 'text_encoders'),
    ('Comfy-Org/Qwen-Image_ComfyUI', '7beb7b647f04469fbe64ba8adc2bb0d7e5e9f73f', 'split_files/vae/qwen_image_vae.safetensors', 'vae'),
    ('lightx2v/Qwen-Image-Edit-2511-Lightning', 'd74eba145674fd7e31b949324e148e21e7118abd', 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', 'loras'),
    ('fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA', 'e3066224ab74263f4a5b6179cd1a3b0a15577e44', 'qwen-image-edit-2511-multiple-angles-lora.safetensors', 'loras'),
]
TTS_FILES = ['config.json', 'generation_config.json', 'merges.txt', 'model.safetensors', 'preprocessor_config.json', 'speech_tokenizer/config.json', 'speech_tokenizer/configuration.json', 'speech_tokenizer/model.safetensors', 'speech_tokenizer/preprocessor_config.json', 'tokenizer_config.json', 'vocab.json']
for flavor, revision in [('Base', 'fd4b254389122332181a7c3db7f27e918eec64e3'), ('CustomVoice', '0c0e3051f131929182e2c023b9537f8b1c68adfe')]:
    name = 'Qwen3-TTS-12Hz-1.7B-' + flavor
    PICKS.extend(('Qwen/' + name, revision, file, 'TTS/Qwen3/' + name) for file in TTS_FILES)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = args.models.resolve(strict=True)
    if not (root / 'diffusion_models').is_dir() or not (root / 'TTS').is_dir():
        raise ValueError('Expected the existing configured ComfyUI model directory')
    state = root / '.createmore-provision'
    state.mkdir(exist_ok=True)
    os.environ['HF_HOME'] = str(state / 'hf')
    os.environ['HF_XET_CHUNK_CACHE_SIZE_BYTES'] = '0'
    os.environ['HF_HUB_DISABLE_XET'] = '1'
    os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '120'
    from huggingface_hub import HfApi
    api = HfApi()
    inventory = {}
    plan = []
    for repo, revision, source, folder in PICKS:
        key = (repo, revision)
        if key not in inventory:
            inventory[key] = {f.rfilename: f for f in api.model_info(repo, revision=revision, files_metadata=True).siblings}
        metadata = inventory[key][source]
        relative = source if repo.startswith('Qwen/') else Path(source).name
        target = root / folder / relative
        target.resolve().relative_to(root)
        sha = metadata.lfs.sha256 if metadata.lfs else None
        plan.append(dict(repo=repo, revision=revision, source=source, target=str(target), size=metadata.size, sha256=sha, existing=target.exists()))
    new_bytes = sum(p['size'] for p in plan if not p['existing'])
    if new_bytes > 80_000_000_000:
        raise ValueError('Model plan exceeds 80 GB; 20 GB reserved for dependencies and temporary data')
    import shutil
    if shutil.disk_usage(root).free < new_bytes + 20_000_000_000:
        raise ValueError('Insufficient free disk space including temporary reserve')
    report = {'model_bytes': new_bytes, 'budget_bytes': 100_000_000_000, 'items': plan}
    manifest = state / 'manifest.json'
    manifest.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'manifest': str(manifest), 'newGB': new_bytes / 1e9, 'files': len(plan), 'apply': args.apply}), flush=True)
    if not args.apply:
        return
    for item in sorted(plan, key=lambda item: not item['repo'].startswith('Qwen/')):
        target = Path(item['target'])
        if not target.exists():
            print('Downloading ' + item['source'], flush=True)
            download(item, target)
        if target.stat().st_size != item['size']:
            raise ValueError('Size mismatch: ' + str(target))
        if item['sha256']:
            with target.open('rb') as stream:
                actual = hashlib.file_digest(stream, 'sha256').hexdigest()
            if actual != item['sha256']:
                raise ValueError('SHA256 mismatch: ' + str(target))
        item['verified'] = True
        manifest.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('Verified ' + target.name, flush=True)

if __name__ == '__main__':
    main()
