#!/usr/bin/env python3
import pathlib
import re
import sys

KUSTOMIZATION_PATH = pathlib.Path("deploy/k8s/kustomization.yaml")
IMAGE_PATTERN_TEMPLATE = r"(- name: {image}\n\s+newName: {image}\n\s+digest: )(sha256:[0-9a-f]{{64}})"

if len(sys.argv) != 3:
    print("usage: update-image-digest.py <image-name> <sha256:digest>", file=sys.stderr)
    sys.exit(2)

image_name = sys.argv[1]
digest = sys.argv[2]
if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
    print("digest must be a sha256 digest", file=sys.stderr)
    sys.exit(2)

if not KUSTOMIZATION_PATH.exists():
    print(f"expected active kustomization at {KUSTOMIZATION_PATH}", file=sys.stderr)
    sys.exit(1)

text = KUSTOMIZATION_PATH.read_text()
pattern = re.compile(
    IMAGE_PATTERN_TEMPLATE.format(image=re.escape(image_name)),
    re.MULTILINE,
)
updated, count = pattern.subn(rf"\1{digest}", text)
if count != 1:
    print(
        f"failed to update digest for {image_name} in {KUSTOMIZATION_PATH}",
        file=sys.stderr,
    )
    sys.exit(1)

KUSTOMIZATION_PATH.write_text(updated)
