"""What each generation did, step by step, kept beside the caches for diagnosis.

A finished video carries its timeline in its metadata; a generation that fails, hangs or is
cancelled leaves nothing. Every stage is therefore also written here as it happens:
`generation-journal.jsonl`, one JSON object per line, in the folder that holds the cache.
"""

import datetime
import json
import os
import sys
import time

LIMIT = 512 * 1024


class Journal:
    def __init__(self, config, job):
        self.started = time.perf_counter()
        self.path = None
        try:
            folder = os.path.dirname(os.path.abspath(config['cacheRoot']))
            if not os.path.isdir(folder):
                return
            self.path = os.path.join(folder, 'generation-journal.jsonl')
            # Keep the last generations only.
            if os.path.exists(self.path) and os.path.getsize(self.path) > LIMIT:
                with open(self.path, 'rb') as handle:
                    handle.seek(-LIMIT // 2, os.SEEK_END)
                    kept = handle.read().split(b'\n', 1)[-1]
                with open(self.path, 'wb') as handle:
                    handle.write(kept)
        except (OSError, KeyError, TypeError):
            self.path = None
        parameters = dict(job.get('parameters', {}))
        if isinstance(parameters.get('prompt'), str):
            parameters['prompt'] = parameters['prompt'][:200]
        self.write(
            event='start',
            at=datetime.datetime.now().isoformat(timespec='seconds'),
            job=job.get('id'),
            pipeline=job.get('pipeline'),
            parameters=parameters,
            components={role: os.path.basename(str(path)) for role, path in job.get('components', {}).items()},
            loras=[item.get('id') for item in job.get('loras', [])],
            references=[item.get('role') for item in job.get('references', [])],
        )

    def write(self, **entry):
        if not self.path:
            return
        entry['t'] = round(time.perf_counter() - self.started, 2)
        torch = sys.modules.get('torch')
        try:
            if torch is not None and torch.cuda.is_initialized():
                free, total = torch.cuda.mem_get_info()
                entry['vram'] = dict(
                    allocated=round(torch.cuda.memory_allocated() / 1024**3, 2),
                    reserved=round(torch.cuda.memory_reserved() / 1024**3, 2),
                    free=round(free / 1024**3, 2),
                )
            with open(self.path, 'a', encoding='utf8') as handle:
                handle.write(json.dumps(entry, ensure_ascii=False, default=str) + '\n')
        except Exception:
            # A journal that cannot be written never stops a generation.
            self.path = None
