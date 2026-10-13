import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('fetch_reference', Path(__file__).with_name('fetch-static-reference.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReferenceArchive(unittest.TestCase):
    def fixture(self, root, extra=None, changed_shard=False):
        shard = b'public numeric fixture'
        manifest = json.dumps({'shards': [{'file': 'features-00001.bin', 'bytes': len(shard),
                                          'sha256': hashlib.sha256(shard).hexdigest()}]}).encode()
        archive = root/'reference.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as target:
            target.writestr('pack/manifest.learned.json', manifest)
            target.writestr('pack/features-00001.bin', b'x'*len(shard) if changed_shard else shard)
            if extra:
                target.writestr(extra, b'extra')
        pins = dict(sizeBytes=archive.stat().st_size, sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
                    manifestBytes=len(manifest), manifestSha256=hashlib.sha256(manifest).hexdigest(),
                    shardCount=1, referenceBytes=len(manifest)+len(shard))
        return archive, pins

    def test_verified_prefixed_pack_is_extracted_as_flat_regular_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, pins = self.fixture(root)
            module.extract_reference(archive, root/'out', pins)
            self.assertEqual({p.name for p in (root/'out').iterdir()}, {'manifest.learned.json', 'features-00001.bin'})

    def test_traversal_and_extra_payloads_fail_before_any_extraction(self):
        for extra in ('../outside', 'pack/.env', 'pack/extra.bin'):
            with tempfile.TemporaryDirectory() as directory, self.subTest(extra=extra):
                root = Path(directory)
                archive, pins = self.fixture(root, extra=extra)
                with self.assertRaises(ValueError):
                    module.extract_reference(archive, root/'out', pins)
                self.assertFalse((root/'out').exists())

    def test_pinned_archive_notices_do_not_become_reference_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, pins = self.fixture(root, extra='LICENSES/TCGDEX-DATABASE-MIT.txt')
            module.extract_reference(archive, root/'out', pins)
            self.assertEqual(len(list((root/'out').iterdir())), 2)

    def test_archive_hash_and_pinned_shard_bytes_are_both_enforced(self):
        for changed in (False, True):
            with tempfile.TemporaryDirectory() as directory, self.subTest(changed=changed):
                root = Path(directory)
                archive, pins = self.fixture(root, changed_shard=changed)
                if not changed:
                    pins['sha256'] = '0'*64
                with self.assertRaises(ValueError):
                    module.extract_reference(archive, root/'out', pins)

    def test_existing_output_and_oversized_manifest_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, pins = self.fixture(root)
            (root/'out').mkdir()
            with self.assertRaises(FileExistsError):
                module.extract_reference(archive, root/'out', pins)
            pins['manifestBytes'] += 1
            with self.assertRaises(ValueError):
                module.extract_reference(archive, root/'other', pins)


if __name__ == '__main__':
    unittest.main()
