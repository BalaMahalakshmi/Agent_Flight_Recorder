"""Run the duplicate-customer demo with flight recording enabled."""

import os

from flight_recorder import Recorder

from .agent import agent_loop
from .tools import CUSTOMERS, reset_db


def main() -> None:
    reset_db()
    messages = [
        {"role": "user", "content": "Please delete the duplicate Priya Sharma record."}
    ]
    system = "You are a helpful customer support assistant."

    with Recorder(
        "duplicate-customer-demo",
        input={"messages": messages},
        backend_url=os.environ.get(
            "FR_BACKEND_URL", "http://localhost:8000"
        ),
    ) as recorder:
        answer = agent_loop(messages, system)
        recorder.output = answer

    print(f"Agent answer: {answer}")
    print(f"Final database: {CUSTOMERS}")


if __name__ == "__main__":
    main()
