"""A small Anthropic-compatible tool-calling agent for the demo."""

from __future__ import annotations

import json
import os
import uuid
from typing import Any

from flight_recorder import record_step

from .tools import TOOLS, delete_customer, find_customers

_MODEL = "claude-sonnet-4-20250514"
_MAX_TURNS = 10


def _mock_llm(messages: list[dict[str, Any]], system: str) -> list[dict[str, Any]]:
    """Return predictable tool calls that demonstrate a mistaken deletion."""
    tool_results: list[dict[str, Any]] = []
    for message in messages:
        if message.get("role") == "user" and isinstance(message.get("content"), list):
            tool_results.extend(
                block
                for block in message["content"]
                if isinstance(block, dict) and block.get("type") == "tool_result"
            )

    parsed_results: list[Any] = []
    for block in tool_results:
        content = block.get("content")
        if isinstance(content, list):
            content = "".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            )
        if isinstance(content, str):
            parsed_results.append(json.loads(content))

    deletion = next(
        (result for result in reversed(parsed_results)
         if isinstance(result, dict) and "deleted" in result),
        None,
    )
    if deletion is not None:
        if deletion.get("deleted"):
            customer = deletion["customer"]
            answer = (
                f"Deleted customer {customer['customer_id']} "
                f"({customer['name']}, {customer['status']})."
            )
        else:
            answer = deletion["error"]
        return [{"type": "text", "text": answer}]

    search = next(
        (
            result
            for result in reversed(parsed_results)
            if isinstance(result, dict) and isinstance(result.get("customers"), list)
        ),
        None,
    )
    if search is None:
        user_text = " ".join(
            message.get("content", "")
            for message in messages
            if message.get("role") == "user" and isinstance(message.get("content"), str)
        )
        name = "Priya Sharma" if "Priya Sharma" in user_text else "Arjun Rao"
        return [
            {
                "type": "tool_use",
                "id": f"mock-{uuid.uuid4().hex}",
                "name": "find_customers",
                "input": {"name": name},
            }
        ]

    customers = search["customers"]
    if not customers:
        return [{"type": "text", "text": "No matching customers were found."}]

    if "verify" in system.casefold():
        customer = next(
            (item for item in customers if item.get("status") == "duplicate"),
            customers[0],
        )
    else:
        customer = customers[0]

    return [
        {
            "type": "tool_use",
            "id": f"mock-{uuid.uuid4().hex}",
            "name": "delete_customer",
            "input": {"customer_id": customer["customer_id"]},
        }
    ]


@record_step("llm")
def llm_call(messages: list[dict[str, Any]], system: str) -> dict[str, Any]:
    """Call Anthropic when configured, otherwise use the deterministic mock."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        content = _mock_llm(messages, system)
        return {
            "content": content,
            "tokens_in": len(json.dumps({"messages": messages, "system": system})) // 4,
            "tokens_out": len(json.dumps(content)) // 4,
        }

    from anthropic import Anthropic

    response = Anthropic(api_key=api_key).messages.create(
        model=_MODEL,
        max_tokens=1024,
        system=system,
        messages=messages,
        tools=TOOLS,
    )
    return {
        "content": [block.model_dump() for block in response.content],
        "tokens_in": response.usage.input_tokens,
        "tokens_out": response.usage.output_tokens,
    }


@record_step("tool")
def run_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Run one of the tools exposed to the language model."""
    if name == "find_customers":
        return find_customers(args["name"])
    if name == "delete_customer":
        return delete_customer(args["customer_id"])
    raise ValueError(f"Unknown tool: {name}")


def agent_loop(messages: list[dict[str, Any]], system: str) -> str:
    """Continue a conversation until the model returns a final text answer."""
    conversation = list(messages)

    for _ in range(_MAX_TURNS):
        response = llm_call(conversation, system)
        content = response["content"]
        if isinstance(content, str):
            conversation.append({"role": "assistant", "content": content})
            return content
        if not isinstance(content, list):
            raise TypeError("LLM content must be text or a list of content blocks.")

        conversation.append({"role": "assistant", "content": content})
        tool_uses = [
            block for block in content
            if isinstance(block, dict) and block.get("type") == "tool_use"
        ]
        if not tool_uses:
            text = "\n".join(
                block["text"]
                for block in content
                if isinstance(block, dict)
                and block.get("type") == "text"
                and isinstance(block.get("text"), str)
            )
            if not text:
                raise RuntimeError("LLM response contained neither a tool call nor text.")
            return text

        results = []
        for tool_use in tool_uses:
            result = run_tool(tool_use["name"], tool_use["input"])
            results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use["id"],
                    "content": json.dumps(result, ensure_ascii=False),
                }
            )
        conversation.append({"role": "user", "content": results})

    raise RuntimeError(f"Agent did not finish after {_MAX_TURNS} LLM calls.")
