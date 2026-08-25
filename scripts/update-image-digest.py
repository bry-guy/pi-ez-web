#!/usr/bin/env python3
import pathlib
import re
import sys

IMAGE_PATTERN_TEMPLATE = r"(- name: {image}\n\s+newName: {image}\n\s+digest: )(sha256:[0-9a-f]{{64}})"

if len(sys.argv) != 4:
    print(
        "usage: update-image-digest.py <kustomization-path> <image-name> <sha256:digest>",
        file=sys.stderr,
    )
    sys.exit(2)

kustomization_path = pathlib.Path(sys.argv[1])
image_name = sys.argv[2]
digest = sys.argv[3]
if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
    print("digest must be a sha256 digest", file=sys.stderr)
    sys.exit(2)

if not kustomization_path.exists():
    print(f"expected kustomization at {kustomization_path}", file=sys.stderr)
    sys.exit(1)

text = kustomization_path.read_text()
pattern = re.compile(
    IMAGE_PATTERN_TEMPLATE.format(image=re.escape(image_name)),
    re.MULTILINE,
)
updated, count = pattern.subn(rf"\1{digest}", text)
if count != 1:
    print(
        f"failed to update digest for {image_name} in {kustomization_path}",
        file=sys.stderr,
    )
    sys.exit(1)

kustomization_path.write_text(updated)
