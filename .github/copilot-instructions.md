# Project: Agent Flight Recorder
A black box for AI agents: record every step, show a timeline, replay from a step with an edited prompt, and explain failures.

## Stack
Python 3.10+, FastAPI, SQLite, React + Vite. No extra frameworks unless I ask.

## Folders
- sdk/flight_recorder/ : recorder SDK (@record_step decorator, Recorder class)
- backend/ : FastAPI app (store runs, replay, explain)
- demo_agent/ : small tool-calling agent that fails on purpose
- frontend/ : React timeline UI

## Rules
- Keep code simple and commented. I am a beginner with agents.
- Work on one small task at a time, then stop and tell me how to test it.
- Never delete files or run destructive commands without asking.
- Explain what you changed in 3-4 lines after each task.