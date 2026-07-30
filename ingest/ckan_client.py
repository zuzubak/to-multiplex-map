"""Thin client for the City of Toronto Open Data CKAN API.

No API key is required -- all datasets used by this project are public. Note:
`datastore_search_sql` is blocked by the portal's WAF for external callers (confirmed by
testing -- it 403s even on a trivial SELECT), so this client sticks to the plain
`datastore_search` action, restricting to the columns we need via `fields` and paginating
with limit/offset.
"""
from __future__ import annotations

import requests

BASE_URL = "https://ckan0.cf.opendata.inter.prod-toronto.ca"
DEFAULT_PAGE_SIZE = 20_000
TIMEOUT_SECONDS = 120


def datastore_search(
    resource_id: str,
    fields: list[str] | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> list[dict]:
    """Fetch every record from a datastore-active resource, paginating as needed."""
    records: list[dict] = []
    offset = 0
    while True:
        params = {"resource_id": resource_id, "limit": page_size, "offset": offset}
        if fields:
            params["fields"] = ",".join(fields)

        resp = requests.get(
            f"{BASE_URL}/api/3/action/datastore_search",
            params=params,
            timeout=TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        payload = resp.json()
        if not payload.get("success"):
            raise RuntimeError(f"CKAN query failed for resource {resource_id}: {payload}")

        batch = payload["result"]["records"]
        records.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size

    return records
