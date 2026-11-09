"""Start the offline worker: python -m runner --config PATH."""
import argparse
import json
import os
from pathlib import Path


def main():
    os.environ['HF_HUB_OFFLINE']='1'
    os.environ['TRANSFORMERS_OFFLINE']='1'
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',required=True,type=Path)
    args=parser.parse_args()
    from runner.contracts import validate_config
    from runner.models.headers import unique_object
    from runner.protocol import serve
    config=validate_config(json.loads(args.config.read_text(encoding='utf-8-sig'),object_pairs_hook=unique_object))
    serve(config)


if __name__=='__main__':main()
