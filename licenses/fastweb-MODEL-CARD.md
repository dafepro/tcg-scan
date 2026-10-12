---
license: mit
tags:
- computer-vision
- onnx
- object-detection
- card-detection
- collectorvision
library_name: onnx
---

# ccgdetector-fastweb-single

ONNX corner detector for CollectorVision-style card scanning. This release is **fastweb-single 1.39** (`corndog`), an EfficientViT-B0 global-token SimCC model exported for 384x384 RGB input.

## Model details

| Property | Value |
|---|---|
| Architecture | EfficientViT-B0 + global-token SimCC head |
| Input | 384×384 RGB, ImageNet-normalized |
| Outputs | corners (8 floats, normalized [0,1]), compatibility presence logit, sharpness scalar |
| Parameters | ~0.77M |
| File size | 3.19 MB (fp32 ONNX, stripped) |
| Local CPU speed | 8.4 ms / frame, 119.4 FPS (ONNX Runtime CPU, single thread, 384×384) |
| Codename | corndog |
| Latest version | 1.39 |

## Artifact

| File | Notes |
|---|---|
| `fastweb-single-1.39.onnx` | Versioned stable-available artifact. |
| `model.onnx` | Alias for the same file. |

## Status

This release is available through the CollectorVision **stable** channel for the
`fastweb-single` family. Cornelius remains the conservative stable default
detector family, while fastweb-single is the smaller/faster stable-available
alternative for consumers that explicitly select it.

## Metrics

Normal eval, selected checkpoint epoch 39:

| metric | value |
|---|---:|
| validation IoU | 0.953966 |
| test IoU | 0.968839 |
| validation collapse count | 77 |
| test collapse count | 13 |

Full ±50 rotation stress:

| metric | value |
|---|---:|
| mean IoU | 0.974255 |
| p10 IoU | 0.960757 |
| bad `<0.5` | 1 |
| collapse count | 0 |

## Comparison with Cornelius

Cornelius 2.12 is the stable conservative default. `fastweb-single` is a smaller
and faster stable-available alternative with the same 384×384 input contract and the same
three output tensors: `corners`, compatibility `presence`, and `sharpness`.

| Model | Channel | Normal test IoU | Normal collapse | Full ±50° mean / p10 IoU | Full-rotation bad / collapse | ONNX size | Params | Local CPU speed |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Cornelius 2.12 | stable | **0.968911** | 18 | 0.970411 / 0.954621 | **0 / 0** | 4.41 MB | 1.05M | 23.2 ms / 43.0 FPS |
| fastweb-single 1.39 | stable + testing | 0.968839 | **13** | **0.974255 / 0.960757** | 1 / 0 | **3.19 MB** | **0.77M** | **8.4 ms / 119.4 FPS** |

Takeaways:

- Normal accuracy is effectively tied: fastweb-single trails Cornelius by
  0.000072 IoU on the normal held-out test.
- fastweb-single is about 28% smaller on disk and about 2.8× faster in the
  local single-thread CPU benchmark.
- fastweb-single has stronger rotation-stress mean and p10 IoU, but still has
  one remaining bad rotation-stress case where Cornelius has zero.
- The current published ONNX uses argmax SimCC decoding. Local experiments with
  parabolic peak refinement showed small gains, but that refinement is not baked
  into this artifact.

Speed benchmark details: ONNX Runtime 1.24.4, CPUExecutionProvider,
`intra_op_num_threads=1`, `inter_op_num_threads=1`, 50 warmup runs and 300 timed
runs on a 384×384 float32 input. These numbers are intended for model-to-model
comparison on the same machine, not as universal device benchmarks.

## Outputs

- **corners** — 8 floats `[x0,y0, x1,y1, x2,y2, x3,y3]` in TL→TR→BR→BL order, normalized [0,1]
- **presence** — compatibility logit. For this release it is a constant `1.0`; prefer the sharpness gate.
- **sharpness** — mean peak of the 8 SimCC softmax distributions; use this for card-present gating.
