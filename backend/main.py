"""FastAPI endpoints for saving, viewing, replaying, and explaining runs."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import db
from .explainer import explain

db.init()

app = FastAPI(title="Agent Flight Recorder")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ReplayRequest(BaseModel):
    step_index: int
    system: str | None = None
    user_message: str | None = None


@app.get("/api/runs")
def list_runs() -> list[dict[str, Any]]:
    return db.list_runs()


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    run = db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    return run


@app.post("/api/runs")
def save_run(run: dict[str, Any]) -> dict[str, str]:
    db.save_run(run)
    return {"status": "saved"}


@app.post("/api/runs/{run_id}/replay")
def replay_run(run_id: str, request: ReplayRequest) -> dict[str, Any]:
    run = db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")

    steps = run.get("steps")
    if (
        not isinstance(steps, list)
        or request.step_index < 0
        or request.step_index >= len(steps)
    ):
        raise HTTPException(status_code=400, detail="Invalid step_index.")

    step = steps[request.step_index]
    if not isinstance(step, dict) or step.get("kind") != "llm":
        raise HTTPException(status_code=400, detail="Only LLM steps can be replayed.")

    saved_input = step.get("input")
    if not isinstance(saved_input, dict):
        raise HTTPException(status_code=400, detail="The LLM step has no saved input.")
    saved_messages = saved_input.get("messages")
    if not isinstance(saved_messages, list) or not all(
        isinstance(message, dict) for message in saved_messages
    ):
        raise HTTPException(
            status_code=400, detail="The LLM step has invalid saved messages."
        )
    saved_system = saved_input.get("system")
    if not isinstance(saved_system, str):
        raise HTTPException(status_code=400, detail="The LLM step has no saved system.")

    messages = [dict(message) for message in saved_messages]
    system = request.system if request.system is not None else saved_system
    if request.user_message is not None:
        for message in messages:
            if message.get("role") == "user" and isinstance(
                message.get("content"), str
            ):
                message["content"] = request.user_message
                break
        else:
            messages.append({"role": "user", "content": request.user_message})

    inherited_steps = []
    for previous_step in steps[:request.step_index]:
        inherited = dict(previous_step)
        inherited["inherited"] = True
        inherited_steps.append(inherited)

    from demo_agent.agent import agent_loop
    from demo_agent.tools import reset_db
    from flight_recorder import Recorder

    reset_db()
    with Recorder(
        run.get("name", "replay"),
        input=run.get("input"),
        on_finish=db.save_run,
        initial_steps=inherited_steps,
        parent_run_id=run_id,
        forked_from_step=request.step_index,
    ) as recorder:
        recorder.output = agent_loop(messages, system)

    return recorder.to_dict()


@app.post("/api/runs/{run_id}/explain")
def explain_run(run_id: str) -> dict[str, str]:
    run = db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    explanation = explain(run)
    run["explanation"] = explanation
    db.save_run(run)
    return {"explanation": explanation}
