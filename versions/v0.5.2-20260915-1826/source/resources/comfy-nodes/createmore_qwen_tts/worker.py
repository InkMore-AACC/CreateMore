"""One speech request per process: cancellation releases its CUDA context."""
import json
from pathlib import Path
import sys

def main():
    import numpy as np
    import torch
    from qwen_tts import Qwen3TTSModel
    job = Path(sys.argv[1]).resolve(strict=True)
    request = json.loads((job / 'request.json').read_text(encoding='utf-8'))
    torch.manual_seed(request['seed'])
    model = Qwen3TTSModel.from_pretrained(request['model'], device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa', local_files_only=True)
    common = dict(text=request['text'], language=request['language'], max_new_tokens=request['max_new_tokens'])
    if request['mode'] == 'voice_design':
        wavs, sr = model.generate_voice_design(**common, instruct=request['instruction'])
    elif request['mode'] == 'custom_voice':
        wavs, sr = model.generate_custom_voice(**common, speaker=request['speaker'], instruct=request['instruction'])
    else:
        with np.load(job / 'reference.npz', allow_pickle=False) as reference:
            audio = reference['waveform'].copy()
            sample_rate = int(reference['sample_rate'])
        wavs, sr = model.generate_voice_clone(**common, ref_audio=(audio, sample_rate), ref_text=request['reference_text'] or None, x_vector_only_mode=not bool(request['reference_text'].strip()))
    np.savez(job / 'result.npz', waveform=np.asarray(wavs[0], dtype=np.float32), sample_rate=sr)

if __name__ == '__main__':
    main()
