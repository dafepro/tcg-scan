# Historical ORB physical-photo evaluation

Measured on 2026-10-12 before the learned-matcher integration. This report preserves the ORB baseline and exploratory detector results; it is not a description of the current default learned pipeline or a release accuracy certification. See [learned validation](learned-validation.md) for the later XFeat/Fastweb evidence and remaining limits.

## Bottom line

The continuous camera, independent tracks, durable saves and undo work through the actual browser UI. That does **not** establish reliable recognition of physical cards. The unchanged OpenCV baseline produced no automatic identity matches in an initial four-photograph convenience sample. Later ordinary development photos include successful tabletop and binder matches alongside substantial misses, detailed below. Local feature matching is real, but the current source release must be treated as experimental.

The sample is small and difficult: distant cards, oblique views, overlap, sleeves, slabs and a low-resolution binder. It does not estimate ordinary close-up camera accuracy. The photographs used to diagnose changes are development inputs, not a held-out validation set for those changes.

## Unchanged baseline

The actual application engine was run with both a 155-reference Pokémon pack and a 2,000-reference Pokémon subset. No acceptance thresholds were weakened. Sources are linked below; raw photographs and their overlays are not distributed in this repository.

| Photograph                                    | Whole-frame result with either pack            | Interpretation                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pokémon collection, 1,080 × 1,317             | No card quadrilaterals; no accepted identities | Small, overlapping and foreshortened cards include recognizable indexed Base Set artwork. Detection failed before matching.                                                                      |
| Magic binder, 640 × 480                       | Three quadrilaterals; all quality-rejected     | Two full card faces plus a false text-area region. These cards are outside the Pokémon packs, but this is not a matching-stage unknown-rejection test because quality checks stopped every crop. |
| Pokémon card battle, originally 4,752 × 3,168 | No quadrilaterals                              | Downscaled to 4,096 px maximum side for the engine input limit. Exact identities are unreadable; an unscored detection stress case.                                                              |
| Pyrkon card play, 2,861 × 2,011               | No quadrilaterals                              | Exact identities are unreadable; an unscored detection stress case.                                                                                                                              |

Five manually supplied regions from the collection photo were also analyzed, separately from automatic detection. Two visible Charizards retrieved Base Set artwork in the 155-reference pack, but only eight geometric inliers each, insufficient for acceptance. At 2,000 references, the correct artwork fell outside the eight-candidate hash shortlist. Smaller Blastoise and Venusaur regions failed the minimum source-size check. A selected Lugia artwork was unindexed and too small. Printing, edition, finish and authenticity were not established.

This separates at least three problems: finding the card boundary, retrieving the right reference at scale, and having enough distinctive image detail to verify the match. A larger reference index alone fixes none of these automatically.

## Ordinary photographed cards: development subset

A subsequent separately sourced batch contains ten actual photographs, split into five development images and five reserved images before application evaluation. The five development photos below contain 27 fully visible cards. The unchanged baseline was tested first, before using these findings to diagnose changes. These are a convenience sample, not a population accuracy estimate, and photographed objects are not automatically authentic cards.

| Development photograph                               | Visible cards | Detected full faces | Correct eligible names, 155 refs | Correct eligible names, 2,000 refs |
| ---------------------------------------------------- | ------------: | ------------------: | -------------------------------: | ---------------------------------: |
| Four starters on a countertop                        |             4 |                   4 |                                0 |                                  4 |
| Pikachu on wood                                      |             1 |                   1 |                                1 |                                  0 |
| Four starters on a textured pale surface             |             4 |                   1 |                                1 |                                  1 |
| Nine Black Star promos in a sleeve page              |             9 |                   9 |                                9 |                                  9 |
| Nine Base Set holo cards in a binder on a blue towel |             9 |                   9 |                                0 |                                  0 |
| Total                                                |            27 |                  24 |                               11 |                                 14 |

No wrong card-name identity was auto-eligible in this finite development subset. That does not calibrate a false-positive rate, especially for unrelated or out-of-index objects. At 2,000 references, only eight of the fourteen accepted top reference IDs corresponded to the photographed collector number. The other six selected same-name reprints or a different finish. **These are card-name identity matches, not successful physical-printing identification.** Automatic rows therefore say “Visual reference,” retain an unconfirmed-printing flag, omit exact set/number assertions from CSV, and remain excluded from valuation totals.

The promo sleeve-page photo has real plastic curvature and reflections, but its white studio background appears cleaned or processed. It is a useful physical-photo positive control, not a handheld phone-video result. The Base Set binder's zero accepted identities, despite all nine boundaries being detected, shows that foil/reference appearance and geometric support still matter.

The wood Pikachu's 155-to-2,000 regression exposed a bounded retrieval defect: the correct references were global hash ranks one and two, but the candidate bucket schedule could exclude them before scoring. A correction is being evaluated independently of the unchanged baseline figures above; acceptance thresholds are not being relaxed to hide the regression.

Additional development diagnostics on a close Alakazam, a sleeved Pikachu and a mixed-language binder found boundary misses. Supplying explicitly marked regions allowed several missed cards to verify, separating localization failure from identity failure. Those manual crops are not counted as automatic successes or as additional independent photographs.

Source pages, locally analyzed only; no open redistribution license was established for these photographs:

- [Countertop starters](https://www.ebay.com/itm/203516381474)
- [Pikachu on wood](https://www.ebay.com/itm/334618016559)
- [Textured-surface starters](https://www.ebay.com/itm/124474147363)
- [Black Star promo sleeve page](https://tradingcardsets.com/products/wotc-black-star-promo-partial-set-52-54)
- [Base Set binder on blue towel](https://www.ebay.com/itm/127824393249)

## Reserved photographs: frozen production baseline

After compact exact-hash retrieval and all verification parameters were frozen, an independent pass opened and evaluated the five reserved photographs, containing **27 distinct fully visible cards**. No image, reference feature or threshold was changed for this evaluation. These are still seller/product photos rather than physical phone-camera video, and this small nonrandom sample is not a population accuracy estimate.

| Result                                                                     | 155 references | 2,000 references | 10,000 references |
| -------------------------------------------------------------------------- | -------------: | ---------------: | ----------------: |
| Distinct full card faces localized                                         |        16 / 27 |          16 / 27 |           16 / 27 |
| Correct card-name identities eligible                                      |         5 / 27 |          10 / 27 |           10 / 27 |
| Wrong card-name identities eligible                                        |              0 |                0 |                 0 |
| Chosen reference agrees with photographed set/number, among eligible names |          4 / 5 |           4 / 10 |            4 / 10 |

Each index produced 18 raw quadrilaterals: 16 full-card localizations, one whole binder-page proposal and one artwork-only proposal. Counting raw rectangles as detected cards would overstate coverage. All 15 runs completed within the 1,000 ms analysis budget without deferred or quality-gated crops. A listing title misidentified one photographed Base Set 2 Charmander as Base Set; visible collector-number evidence, not the title, supplied that label.

The 10,000-reference result confirms that **manual intervention is not yet a rare exception**. No wrong accepted name in these 27 cards does not establish a production false-positive rate. Printing remains unconfirmed for every automatic entry, including a reference that happens to agree with the photographed collector number.

This reserved batch was held out for this frozen baseline only. Future changes informed by its failures require a fresh validation set. Completing the full-game index remains a separate task; a larger catalog must not be presented as fixing representation or boundary-detection failures by itself.

### Reproduce on your own local photographs

The original CLI reads existing local images and reference packs, makes no network requests, and never silently substitutes a manual crop:

```sh
npm run evaluate:photos -- --manifest /path/to/photos.json \
  --pack-manifest /path/to/reference-pack/manifest.json \
  --game pokemon --output /path/to/results.json
```

Use `npm run evaluate:photos -- --help` for the manifest schema and limits. Optional input hashes and dimensions are checked. Ground-truth labels are copied to the result, never used to retrieve or identify cards. Counts alone do not establish localization recall; manually adjudicate whether each returned polygon covers a distinct physical card. Reports include local paths and caller-provided metadata: sanitize them before sharing. The CLI does not grant permission to redistribute your input photographs.

## Bounded learned-detector experiment

Two downloaded ONNX models were evaluated as data with official ONNX Runtime, outside the application. They were **not bundled or enabled** in the ORB checkpoint evaluated here. The later learned pipeline stages pinned Fastweb data at install time; Cardstream remains outside the application. Telemetry was disabled before runtime initialization.

- **Cardstream segmentation v2:** approximately 125 MiB ONNX, Apache-2.0 publisher grant for architecture and weights. On the four whole scenes it found no true card proposals at the fixed 0.5 object-score threshold and one false playmat proposal. Five preselected card crops did localize successfully, showing that model preprocessing and inference worked. Cloud CPU inference was about 536 ms median with one thread, or 251 ms with four threads. Those are inference-only cloud measurements, not phone or end-to-end latency.
- **Fastweb-single 1.39:** approximately 3 MiB ONNX, MIT declared in its pinned model card. It predicts one card's corners, and its presence output is always 1.0, including blank inputs. Presence therefore cannot be used as confidence. Warm single-thread cloud inference was 10.6 ms median / 14.4 ms p95. A fixed full-frame-plus-nine-window grid automatically located one of five previously labeled collection regions. Its 35 geometry-valid proposals across four photographs included many broad or non-card regions. Unchanged identity verification rejected all proposals.

The models improve some conditional localization examples, but neither experiment justifies a reliable multi-card detector claim. The larger model is not a useful default merely because it is a neural network; its measured download, memory and runtime costs matter.

## Retrieval and reference-density diagnostic

An isolated artwork-descriptor voting prototype recovered the missing Charizard reference where whole-card hashes did not. Increasing only the two relevant development references from 96 to 500 spatially distributed ORB points then allowed the automatically proposed middle Charizard to pass the **unchanged** geometric gates. Both credible references describe the same card identity but different printings, so the result remains printing-ambiguous.

This is **one physical card recovered in one development photograph**, not three new successful cards because three crop variants were tested. The second foreground Charizard remained rejected. A replay of 576 existing source-image transformations preserved their prior outcomes, including zero new false-eligible results in 384 out-of-pack scenes; these remain synthetic transformations, not independent photographed negatives.

The two dense references added 25,856 raw descriptor bytes and 59,599 JSON bytes. Verification of those two candidates rose from about 5.66 / 6.46 ms p50 / p95 at 96 points to 13.97 / 17.41 ms at 500 points. Uniformly making an entire catalog dense would have substantial download and memory costs. A verifier pack or explicitly disclosed on-demand dense cache needs its own design and evaluation; a special case for these two Charizards is not a production fix.

## What must be established next

1. Independent ordinary close-up card, tidy tabletop and binder photos with readable identity ground truth, kept separate from tuning inputs.
2. Detection recall and candidate-retrieval recall separately from final acceptance, with unseen cards and similar artwork included.
3. Actual physical-camera checks on named phones, including glare, sleeves, motion and camera orientation.
4. Full-index load time, memory and retrieval performance; measured warm local latency must remain separate from first download and stable-save latency.
5. Printing ambiguity and false-positive behavior without loosening safety gates to make a small demonstration succeed.

## Sources and rights

The source pages declare licenses for the photographs. They do not independently license the depicted trading-card artwork. No raw photographs, commercial artwork or model weights are included in this repository.

- [Collection photograph, W00ter92, CC0](https://commons.wikimedia.org/wiki/File:Alex_Aleksandrovski.jpg)
- [Binder photograph, Alex Buell, CC BY-SA 2.5](https://commons.wikimedia.org/wiki/File:Cardbinder.jpg)
- [Card-battle photograph, MIKI Yoshihito, CC BY 2.0](https://commons.wikimedia.org/wiki/File:POKEMON_card_battle.jpg)
- [Pyrkon photograph, Klapi, CC BY-SA 4.0](https://commons.wikimedia.org/wiki/File:Pyrkon_2022_Pokemon_Trading_Card_Game.jpg)
- [Cardstream model contract and license](https://github.com/Ximilar-com/cardstream/blob/c44ba504a528849f8bbd6723696c75931d314484/model/README.md)
- [Fastweb pinned model card](https://huggingface.co/HanClinto/ccgdetector-fastweb-single/blob/66ffd4976ec57bda0f6ea2d83e15ca6a3add7dd9/README.md)
- [ONNX Runtime privacy controls](https://github.com/microsoft/onnxruntime/blob/main/docs/Privacy.md)

For the separately reproducible source-image and original synthetic benchmarks, see [vision benchmarks](vision-benchmarks.md). Those positive pipeline results and the negative physical-photo findings must be read together.
