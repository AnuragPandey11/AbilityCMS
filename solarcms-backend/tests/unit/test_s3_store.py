"""Report files in S3 (docs/CAPACITY_AND_DEPLOYMENT.md §5.1), without AWS.

botocore's Stubber answers in place of S3, so this checks exactly the calls the
store makes — the bucket, the key, server-side encryption — and that a missing
object is None rather than an exception. Skipped where the `aws` extra is not
installed.
"""

from __future__ import annotations

import io

import pytest

boto3 = pytest.importorskip("boto3")
from botocore.response import StreamingBody  # noqa: E402
from botocore.stub import Stubber  # noqa: E402

from solarcms.services.storage import S3ArtifactStore  # noqa: E402


def store() -> tuple[S3ArtifactStore, Stubber]:
    client = boto3.client("s3", region_name="ap-south-1",
                          aws_access_key_id="test", aws_secret_access_key="test")
    return S3ArtifactStore("reports-bucket", "ap-south-1", client=client), Stubber(client)


async def test_put_encrypts_and_returns_the_object_url() -> None:
    s3, stub = store()
    stub.add_response("put_object", {}, {
        "Bucket": "reports-bucket", "Key": "reports/1/2-ab.pdf", "Body": b"%PDF",
        "ContentType": "application/pdf", "ServerSideEncryption": "AES256"})
    with stub:
        assert await s3.put("reports/1/2-ab.pdf", b"%PDF", "application/pdf") == \
            "s3://reports-bucket/reports/1/2-ab.pdf"
    stub.assert_no_pending_responses()


async def test_get_reads_the_body_and_a_missing_object_is_none() -> None:
    s3, stub = store()
    stub.add_response("get_object", {"Body": StreamingBody(io.BytesIO(b"xlsx"), 4)},
                      {"Bucket": "reports-bucket", "Key": "k"})
    stub.add_client_error("get_object", service_error_code="NoSuchKey",
                          expected_params={"Bucket": "reports-bucket", "Key": "gone"})
    with stub:
        assert await s3.get("k") == b"xlsx"
        assert await s3.get("gone") is None


async def test_a_signed_url_is_a_presigned_s3_url_that_expires() -> None:
    s3, _stub = store()
    url = await s3.signed_url("reports/1/2-ab.pdf")
    assert url.startswith("https://reports-bucket.s3")
    assert "Expires=" in url or "X-Amz-Expires=" in url
