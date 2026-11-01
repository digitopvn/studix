"""Studix MCP smoke client using the official Python SDK (pinned by the caller: mcp==2.3.0).

Reads STUDIX_MCP_URL and STUDIX_API_KEY from the environment, connects over Streamable HTTP with a Bearer
key, lists tools, calls studix_inspect and prints one JSON summary line. Exits non-zero on any failure.
"""

import asyncio
import json
import os
import sys

from mcp import ClientSession
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

EXPECTED_TOOLS = {
    "studix_inspect",
    "studix_create_video",
    "studix_get_job",
    "studix_get_project",
    "studix_cancel_job",
    "studix_retry_job",
    "studix_approve",
}


async def run(url: str, key: str) -> dict:
    http_client = create_mcp_http_client(headers={"Authorization": f"Bearer {key}"})
    async with http_client:
        async with streamable_http_client(url, http_client=http_client) as streams:
            read, write = streams[0], streams[1]
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = {tool.name for tool in (await session.list_tools()).tools}
                missing = EXPECTED_TOOLS - tools
                if missing:
                    raise RuntimeError(f"missing tools: {sorted(missing)}")
                result = await session.call_tool("studix_inspect", {})
                if result.is_error:
                    raise RuntimeError("studix_inspect returned an error")
                envelope = result.structured_content or json.loads(result.content[0].text)
                if envelope.get("status") != "ok":
                    raise RuntimeError(f"unexpected envelope status: {envelope.get('status')}")
                return {
                    "tools": sorted(tools),
                    "workspaceId": envelope["data"]["workspaceId"],
                }


def describe(error: BaseException) -> str:
    """Flatten anyio TaskGroup exception groups so the root cause is visible in test output."""
    if isinstance(error, BaseExceptionGroup):
        return "; ".join(describe(inner) for inner in error.exceptions)
    return f"{type(error).__name__}: {error}"


def main() -> int:
    url = os.environ.get("STUDIX_MCP_URL")
    key = os.environ.get("STUDIX_API_KEY")
    if not url or not key:
        print("STUDIX_MCP_URL and STUDIX_API_KEY are required", file=sys.stderr)
        return 2
    try:
        summary = asyncio.run(run(url, key))
    except Exception as error:  # noqa: BLE001 - report any failure as a non-zero exit
        print(f"python sdk smoke failed: {describe(error)}", file=sys.stderr)
        return 1
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
