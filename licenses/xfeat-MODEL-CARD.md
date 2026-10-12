---
license: apache-2.0
tags:
  - kornia
  - feature-detection
  - feature-description
  - image-matching
---

# kornia/xfeat

Pretrained weights for **XFeat** (Accelerated Features for Lightweight Image Matching),
used by [`kornia.feature.XFeat`](https://kornia.readthedocs.io/en/latest/feature.html).

XFeat is a lightweight keypoint detector and descriptor optimised for real-time image
matching. It detects sparse keypoints and computes 64-dim descriptors in a single
forward pass with a fully-convolutional architecture. CVPR 2024.

**Original repo:** [verlab/accelerated_features](https://github.com/verlab/accelerated_features)

## Weights

| File | Description |
|------|-------------|
| `xfeat.safetensors` | Default checkpoint, safetensors format |
| `xfeat.pt` | Default checkpoint, the upstream pickle |

## Provenance

`xfeat.safetensors` holds the tensors of the upstream
[`xfeat.pt`](https://github.com/verlab/accelerated_features/raw/main/weights/xfeat.pt)
(sha256 `0f5187fd7bedd26c7fe6acc9685444493a165a35ecc087b33c2db3627f3ea10b`), unchanged: the same keys, dtypes, shapes
and bits. `xfeat.pt` here is byte-identical to that file. The kornia maintainers converted it (converter revision
`5866995a4c`) and checked that a model loaded from either file gives bitwise-identical outputs. The sha256 of
`xfeat.safetensors` is `d094564230ecab7d3984c0fae055dce9e80050c0fd2fdcf96b165576af5e8571`.

## License

Apache-2.0, the licence of [verlab/accelerated_features](https://github.com/verlab/accelerated_features). See
[`LICENSE`](LICENSE), copied from that repository.

## Citation

```bibtex
@inproceedings{potje2024xfeat,
    author    = {Guilherme {Potje} and Felipe {Cadar} and Andre {Araujo}
                 and Renato {Martins} and Erickson R. {Nascimento}},
    title     = {{XFeat}: Accelerated Features for Lightweight Image Matching},
    booktitle = {CVPR},
    year      = {2024}
}
```
