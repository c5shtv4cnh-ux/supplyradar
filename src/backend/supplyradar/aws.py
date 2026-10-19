"""Lazily created boto3 clients, so module import stays cheap and tests can replace them."""
import os

import boto3
from botocore.config import Config

_clients = {}


def client(name):
    if name not in _clients:
        if name == "s3":
            # Regional virtual-hosted URLs + SigV4 so browser uploads to a new bucket
            # are not answered with a 307 redirect from the global endpoint.
            region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "eu-central-1")
            _clients[name] = boto3.client(
                "s3",
                region_name=region,
                endpoint_url=f"https://s3.{region}.amazonaws.com",
                config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
            )
        else:
            _clients[name] = boto3.client(name)
    return _clients[name]
