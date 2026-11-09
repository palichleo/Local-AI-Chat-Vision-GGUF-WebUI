"""Atomic original images and replayable manifests under the trusted output root."""
import json
import os
from pathlib import Path
import uuid


def save_image(pixels, config, job, metadata):
    from PIL import Image, PngImagePlugin
    destination=Path(config['outputRoot']).resolve()
    destination.mkdir(parents=True,exist_ok=True)
    filename=uuid.uuid4().hex+'.png'
    output=destination/filename; manifest=output.with_suffix('.json')
    temporary=destination/(filename+'.tmp'); temporary_manifest=destination/(filename+'.json.tmp')
    descriptor=dict(filename=filename,subfolder='',type='output',width=job['parameters']['width'],height=job['parameters']['height'])
    result=dict(jobId=job['id'],outputs=[descriptor],metadata=metadata)
    info=PngImagePlugin.PngInfo();info.add_text('atelier',json.dumps(metadata,ensure_ascii=False,allow_nan=False))
    try:
        Image.fromarray(pixels).save(temporary,format='PNG',pnginfo=info)
        temporary_manifest.write_text(json.dumps(result,indent=2,ensure_ascii=False,allow_nan=False),encoding='utf-8')
        os.replace(temporary,output)
        try:os.replace(temporary_manifest,manifest)
        except BaseException:
            output.unlink(missing_ok=True)
            raise
    finally:
        temporary.unlink(missing_ok=True);temporary_manifest.unlink(missing_ok=True)
    return result
