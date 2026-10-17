"""Record agent runs and the steps taken during each run."""

from __future__ import annotations

import asyncio
import contextvars
import copy
import json
import time
import urllib.request
import uuid
from collections.abc import Mapping
from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable, TypeVar

_COST_PER_INPUT_TOKEN = 3 / 1_000_000
_COST_PER_OUTPUT_TOKEN = 15 / 1_000_000

F = TypeVar("F", bound=Callable[..., Any])
_active_recorder: contextvars.ContextVar[Recorder | None] = contextvars.ContextVar(
    "active_flight_recorder", default=None
)


def _token_counts(output: Any) -> tuple[int, int]:
    if not isinstance(output, Mapping):
        return 0, 0

    tokens_in = output.get("tokens_in", 0)
    tokens_out = output.get("tokens_out", 0)
    return (
        tokens_in if isinstance(tokens_in, int) and not isinstance(tokens_in, bool) else 0,
        tokens_out if isinstance(tokens_out, int) and not isinstance(tokens_out, bool) else 0,
    )


def _step_cost(tokens_in: int, tokens_out: int) -> float:
    return (
        tokens_in * _COST_PER_INPUT_TOKEN
        + tokens_out * _COST_PER_OUTPUT_TOKEN
    )


def record_step(kind: str) -> Callable[[F], F]:
    """Record a function call in the active Recorder, if there is one."""
    def decorate(func: F) -> F:
        def record(
            args: tuple[Any, ...],
            kwargs: dict[str, Any],
            output: Any,
            started_at: float,
            error: str | None = None,
        ) -> None:
            recorder = _active_recorder.get()
            if recorder is None:
                return

            if kind == "llm":
                step_input = {
                    "messages": args[0] if args else kwargs.get("messages"),
                    "system": args[1] if len(args) > 1 else kwargs.get("system"),
                }
                name = func.__name__
            else:
                step_input = {"args": list(args), "kwargs": kwargs}
                name = f"tool:{args[0]}" if kind == "tool" and args else func.__name__

            tokens_in, tokens_out = _token_counts(output)
            recorder.steps.append(
                {
                    "index": len(recorder.steps),
                    "kind": kind,
                    "name": name,
                    "input": step_input,
                    "output": output,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "cost": _step_cost(tokens_in, tokens_out),
                    "latency_ms": (time.perf_counter() - started_at) * 1000,
                    "error": error,
                    "inherited": False,
                }
            )

        if asyncio.iscoroutinefunction(func):
            @wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                saved_args, saved_kwargs = copy.deepcopy((args, kwargs))
                started_at = time.perf_counter()
                try:
                    output = await func(*args, **kwargs)
                except Exception as exc:
                    record(saved_args, saved_kwargs, None, started_at, str(exc))
                    raise
                record(saved_args, saved_kwargs, output, started_at)
                return output

            return async_wrapper  # type: ignore[return-value]

        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            saved_args, saved_kwargs = copy.deepcopy((args, kwargs))
            started_at = time.perf_counter()
            try:
                output = func(*args, **kwargs)
            except Exception as exc:
                record(saved_args, saved_kwargs, None, started_at, str(exc))
                raise
            record(saved_args, saved_kwargs, output, started_at)
            return output

        return wrapper  # type: ignore[return-value]

    return decorate


class Recorder:
    """Collect a run and optionally notify a callback and backend on exit."""

    def __init__(
        self,
        name: str,
        input: Any = None,
        backend_url: str | None = None,
        on_finish: Callable[[dict[str, Any]], Any] | None = None,
        initial_steps: list[dict[str, Any]] | None = None,
        parent_run_id: str | None = None,
        forked_from_step: int | None = None,
    ) -> None:
        self.id = str(uuid.uuid4())
        self.name = name
        self.input = input
        self.output: Any = None
        self.status = "ok"
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.backend_url = backend_url
        self.on_finish = on_finish
        self.parent_run_id = parent_run_id
        self.forked_from_step = forked_from_step
        self.steps = [
            self._complete_step(step, index)
            for index, step in enumerate(initial_steps or [])
        ]
        self._context_token: contextvars.Token[Recorder | None] | None = None

    @staticmethod
    def _complete_step(step: dict[str, Any], index: int) -> dict[str, Any]:
        completed = dict(step)
        completed.setdefault("index", index)
        completed.setdefault("kind", "unknown")
        completed.setdefault("name", completed["kind"])
        completed.setdefault("input", None)
        completed.setdefault("output", None)
        completed.setdefault("tokens_in", 0)
        completed.setdefault("tokens_out", 0)
        completed.setdefault("cost", _step_cost(
            completed["tokens_in"], completed["tokens_out"]
        ))
        completed.setdefault("latency_ms", 0)
        completed.setdefault("error", None)
        completed.setdefault("inherited", False)
        return completed

    def __enter__(self) -> Recorder:
        self._context_token = _active_recorder.set(self)
        return self

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        if self._context_token is not None:
            _active_recorder.reset(self._context_token)
            self._context_token = None

        self.status = "error" if exc_type is not None else "ok"
        run = self.to_dict()
        if self.on_finish is not None:
            self.on_finish(run)
        if self.backend_url is not None:
            self._post_run(run)

    def to_dict(self) -> dict[str, Any]:
        """Return the complete run record."""
        return {
            "id": self.id,
            "name": self.name,
            "input": self.input,
            "output": self.output,
            "status": self.status,
            "created_at": self.created_at,
            "parent_run_id": self.parent_run_id,
            "forked_from_step": self.forked_from_step,
            "total_cost": sum(step["cost"] for step in self.steps),
            "total_tokens": sum(
                step["tokens_in"] + step["tokens_out"] for step in self.steps
            ),
            "steps": self.steps,
            "explanation": None,
        }

    def _post_run(self, run: dict[str, Any]) -> None:
        url = f"{self.backend_url.rstrip('/')}/api/runs"
        request = urllib.request.Request(
            url,
            data=json.dumps(run, default=str).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request) as response:
                response.read()
        except Exception as exc:
            print(f"Warning: could not send run to {url}: {exc}")
