"""Generate a short explanation for a recorded run."""

from __future__ import annotations

import json
import os
import re
from typing import Any


def _fallback_step(run: dict[str, Any]) -> tuple[int, str]:
    steps = run.get("steps", [])
    if not isinstance(steps, list):
        steps = []

    for position, step in enumerate(steps):
        if isinstance(step, dict) and step.get("error"):
            index = step.get("index", position)
            return index, f"the step reported an error: {step['error']}"

    for position, step in enumerate(steps):
        if (
            isinstance(step, dict)
            and "delete" in str(step.get("name", "")).casefold()
        ):
            index = step.get("index", position)
            return index, "the model deleted without verifying the target first"

    position = max(len(steps) - 1, 0)
    step = steps[position] if steps else {}
    index = step.get("index", position) if isinstance(step, dict) else position
    return index, "the trace contains no explicit error or destructive tool call"


def explain(run: dict[str, Any]) -> str:
    """Explain the likely failure using Anthropic when configured, else a heuristic."""
    fallback_index, fallback_reason = _fallback_step(run)
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return f"Likely failed at step {fallback_index}: {fallback_reason}."

    from anthropic import Anthropic

    steps = run.get("steps", [])
    compact_steps = []
    if isinstance(steps, list):
        for position, step in enumerate(steps):
            if isinstance(step, dict):
                compact_steps.append(
                    {
                        "index": step.get("index", position),
                        "kind": step.get("kind"),
                        "name": step.get("name"),
                        "input": step.get("input"),
                        "output": step.get("output"),
                        "error": step.get("error"),
                    }
                )

    response = Anthropic().messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=160,
        system=(
            "Explain the likely failure in this agent trace in one short sentence. "
            "Start the response exactly with 'Likely failed at step N:' where N is "
            "the relevant step index. If there is no clear failure, say so."
        ),
        messages=[
            {
                "role": "user",
                "content": json.dumps(compact_steps, ensure_ascii=False, default=str),
            }
        ],
    )
    explanation = next(
        (
            block.text.strip()
            for block in response.content
            if getattr(block, "type", None) == "text" and block.text.strip()
        ),
        "",
    )
    if not explanation:
        raise RuntimeError("The explanation model returned no text.")
    if not re.match(r"^Likely failed at step \d+:", explanation):
        explanation = f"Likely failed at step {fallback_index}: {explanation}"
    return explanation
